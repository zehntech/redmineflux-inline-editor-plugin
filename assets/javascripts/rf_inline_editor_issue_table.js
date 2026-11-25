/**
 * RF Inline Editor — Issue List Table Module
 * Handles click-to-edit for every editable cell in the issue index table.
 *
 * Design principles:
 *  • Edit happens inside the SAME cell — no TD insertion/removal.
 *  • Cell width is locked before edit starts so the table never reflows.
 *  • Enter saves; Escape or click-outside cancels.
 *  • Searchable dropdowns for Assignee, Version, and Project fields.
 *  • No Save/Cancel buttons.
 *  • All saves validated server-side via Redmine REST API.
 *  • Permission check on every save; UI reverts if server denies.
 */
(function (window, document) {
  'use strict';

  var RfIE = window.RfIE;
  if (!RfIE) { console.error('RfIE core not loaded'); return; }

  /* Only operate on the issues index page */
  if (!document.body.classList.contains('controller-issues') ||
      !document.body.classList.contains('action-index')) return;

  /* Permission guard — exit entirely only if the user can edit NEITHER all
     issues NOR their own. A user with only :edit_own_issues previously got
     canEditIssues = false here (that flag means "can edit every issue") and
     the inline editor never appeared at all, even on issues they authored.
     Per-row enforcement of the "own issues only" restriction happens in
     decorateRow below via each row's own 'created-by-me' CSS class (already
     stamped by Issue#css_classes) — this guard only decides whether the
     module is worth initializing on this page at all. */
  if (!RfIE.config.canEditIssues && !RfIE.config.canEditOwnIssues) return;

  var BASE = RfIE.config.baseUrl;

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* Parse an estimated-hours display string into a decimal number of hours.
     Redmine's own list column renders estimated_hours as "H:MM" whenever
     Setting.timespan_format is 'minutes' (see lib/redmine/i18n.rb#format_hours),
     and as a plain decimal ("5.5") otherwise. The inline editor's <input
     type="number"> can only hold a decimal, so re-opening an "H:MM" cell must
     convert it to decimal first — naively stripping non-digit characters
     (the previous behaviour) destroyed the colon and turned "5:30" into the
     nonsensical "530". Mirrors Redmine's own String#to_hours (lib/redmine/
     core_ext/string/conversions.rb) for the "H:MM" and decimal cases. */
  function parseHoursDisplay(text) {
    var s = String(text || '').trim();
    if (!s) return '';
    var hm = s.match(/^(\d+):(\d+)$/);
    if (hm) return String(parseInt(hm[1], 10) + parseInt(hm[2], 10) / 60);
    var dec = s.match(/(\d+(?:[.,]\d+)?)/);
    return dec ? dec[1].replace(',', '.') : '';
  }

  /* Rebuild the Redmine-native done_ratio cell HTML (progress bar + label).
     Matches the exact structure Redmine renders so existing progress CSS applies. */
  function doneRatioHtml(pct) {
    pct = parseInt(pct, 10) || 0;
    var open = 100 - pct;
    var rows = pct > 0
      ? '<td class="closed" style="width:' + pct + '%" title="' + pct + '%"></td>' +
        (open > 0 ? '<td class="todo" style="width:' + open + '%"></td>' : '')
      : '<td class="todo" style="width:100%"></td>';
    return '<table class="progress progress-' + pct + '">' +
           '<tbody><tr>' + rows + '</tr></tbody>' +
           '</table>' +
           '<p class="percent">' + pct + ' %</p>';
  }

  /* ── Cache for async data (keyed by project/issue id) ─────── */
  var _cache = {
    members:      {},   /* projectId → [{id, name}] */
    statuses:     {},   /* issueId   → [{id, name}] */
    versions:     {},   /* projectId → [{id, name}] */
    trackers:     {},   /* projectId → [{id, name}] */
    projects:     null, /* [{id, name}]              */
    cfields:      null, /* [{id, name, field_format, possible_values, multiple, …}] */
    sprints:      {},   /* projectId → [{id, name}] */
    storyPoints:  null  /* [{id, name}]              */
  };

  /* ── Non-editable cell classes ─────────────────────────────── */
  var SKIP_CLASSES = [
    'id','checkbox','author','created_on','updated_on','closed_on',
    'parent','parent-subject','spent_hours','total_spent_hours',
    'total_estimated_hours','relations','last_updated_by','is_private',
    'attachment','attachments','tags','watcher_users',
    'estimated_remaining_hours','enumeration','buttons','todo'
  ];

  /* ── Fields that need a searchable dropdown in the table ───── */
  var SEARCHABLE_FIELDS = ['assigned_to', 'fixed_version', 'project'];

  /* ── Fields rendered as a plain select (small static lists) ── */
  var SELECT_FIELDS = ['status', 'priority', 'tracker', 'category'];

  /* ── Custom field formats and their control type ───────────── */
  var CF_CONTROLS = {
    string: 'text', text: 'textarea', int: 'number', float: 'number',
    date: 'date', link: 'text', bool: 'select', list: 'select',
    user: 'searchable', version: 'searchable'
  };

  /* ────────────────────────────────────────────────────────────
     INITIALISE — add pencil icons to all editable cells
     ──────────────────────────────────────────────────────────── */
  function init() {
    var table = document.querySelector('table.list.issues');
    if (!table) return;

    /* Prefetch custom field definitions once */
    loadCustomFields();

    decorateCells(table);
    disableNonEditableCFCells();

    /* Re-decorate when Redmine re-renders the table (e.g. pagination/filter) */
    observeTableMutations(table);
  }

  function decorateCells(table) {
    var rows = table.querySelectorAll('tbody tr.issue, tbody tr[id^="issue-"]');
    rows.forEach(function (tr) { decorateRow(tr); });
  }

  /* Fields whose value Redmine computes ("derives") from child issues once
     an issue has children — matches Issue#dates_derived? / #priority_derived? /
     #done_ratio_derived? in app/models/issue.rb, which strips these names from
     safe_attribute_names for such issues, and which Redmine's own edit form
     therefore renders read-only. Redmine stamps a "parent" class on any row
     whose issue has children (Issue#css_classes → app/views/issues/_list.html.erb),
     so that class combined with the matching core Setting (injected into
     RfIE.config by _rf_header_assets.html.erb) is enough to reproduce the
     same lock client-side without an extra request per row. */
  var PARENT_DERIVED_DATE_CLASSES = ['start_date', 'due_date'];
  var PARENT_DERIVED_RATIO_CLASS  = 'done_ratio';
  var PARENT_DERIVED_PRIORITY_CLASS = 'priority';

  function isParentDerivedLocked(tr, cls) {
    var isParentRow = tr.classList.contains('parent');
    if (!isParentRow) return false;
    if (PARENT_DERIVED_DATE_CLASSES.indexOf(cls) >= 0) {
      return !!RfIE.config.parentIssueDatesDerived;
    }
    if (cls === PARENT_DERIVED_RATIO_CLASS) {
      return !!RfIE.config.parentIssueDoneRatioDerived;
    }
    if (cls === PARENT_DERIVED_PRIORITY_CLASS) {
      return !!RfIE.config.parentIssuePriorityDerived;
    }
    return false;
  }

  function decorateRow(tr) {
    /* Skip already-decorated rows */
    if (tr.dataset.rfDecorated) return;
    tr.dataset.rfDecorated = '1';

    /* Users with the full :edit_issues permission may edit every row.
       Users with ONLY :edit_own_issues may edit exclusively rows for issues
       they authored — Redmine core already stamps a 'created-by-me' class
       on such rows (Issue#css_classes, rendered in _list.html.erb), so no
       extra fetch is needed to tell them apart. Skip decorating (no pencils
       at all) any row this user isn't allowed to touch, rather than relying
       solely on the page-wide guard above, which can no longer tell rows
       apart once it lets an own-issues-only user's session through. */
    if (!RfIE.config.canEditIssues &&
        !(RfIE.config.canEditOwnIssues && tr.classList.contains('created-by-me'))) return;

    /* Only the row's own top-level columns — NOT ':scope > td' would be the
       obvious way to say that, but querySelectorAll('td') also matches the
       done_ratio column's nested progress-bar markup (progress_bar() in
       app/helpers/application_helper.rb renders <td class="closed">/"done"/
       "todo"> INSIDE a <table> inside the done_ratio <td>). Those inner tds
       have their own single class ('closed' etc.) that matches neither
       SKIP_CLASSES nor the parent-derived-lock check for 'done_ratio', so on
       a parent row where the outer done_ratio cell is correctly left alone
       (Bug 4's fix, isParentDerivedLocked), its untouched nested <td
       class="closed"> was still being individually matched by this
       querySelectorAll and wrapped with its own stray pencil icon — the
       outer cell's own reset+rebuild on ordinary rows happened to clobber
       that same stale nested-td reference first, which is why this only
       showed up on parent (derived-locked) rows. Array.from(tr.children)
       walks only the row's real columns and skips the progress bar's
       internals entirely. */
    Array.from(tr.children).filter(function (el) { return el.tagName === 'TD'; }).forEach(function (td) {
      /* Skip non-editable columns */
      var cls = cellClass(td);
      if (!cls || SKIP_CLASSES.indexOf(cls) >= 0) return;

      /* Parent issue with start_date/due_date/done_ratio computed from its
         children under the relevant core Setting — Redmine's own form locks
         these, so the inline editor must not offer them either (Bug 4). */
      if (isParentDerivedLocked(tr, cls)) return;

      /* Wrap existing content in a .rf-cell-wrapper span for flex layout */
      var existing = td.innerHTML.trim();
      var wrapper = document.createElement('span');
      wrapper.className = 'rf-cell-wrapper';

      var display = document.createElement('span');
      display.className = 'rf-cell-display';
      display.innerHTML = existing;

      /* done_ratio: Redmine renders <p class="percent"> empty by default.
         Fill it from the progress bar width so the percentage always shows. */
      if (cls === 'done_ratio') {
        var pctP = display.querySelector('p.percent');
        if (pctP && !pctP.textContent.trim()) {
          var closedCell = display.querySelector('td.closed');
          var pctNum = closedCell
            ? (parseInt(closedCell.title, 10) || parseInt(closedCell.style.width, 10) || 0)
            : 0;
          pctP.textContent = pctNum + ' %';
        }
      }

      var icon = RfIE.dom.editIcon();

      wrapper.appendChild(display);
      wrapper.appendChild(icon);
      td.innerHTML = '';
      td.appendChild(wrapper);

      /* JS-driven hover: look up the icon each time so that after a cancel
         (which replaces wrapper.innerHTML) the new icon element is found */
      td.addEventListener('mouseenter', function () {
        if (td.classList.contains('rf-no-edit')) return;
        var el = td.querySelector('.rf-edit-icon');
        if (el && !td.classList.contains('rf-editing')) el.style.opacity = '0.7';
      });
      td.addEventListener('mouseleave', function () {
        var el = td.querySelector('.rf-edit-icon');
        if (el) el.style.opacity = '0';
      });

      /* Use event delegation on td rather than a direct listener on the icon.
         After restoreCell reconstructs the cell via innerHTML the old icon JS
         object is gone, but td persists — clicks on any .rf-edit-icon inside
         this td will bubble up here and trigger the edit correctly. */
      td.addEventListener('click', function (e) {
        if (td.classList.contains('rf-editing')) return;
        if (td.classList.contains('rf-no-edit')) return;
        var tgt = e.target;
        while (tgt && tgt !== td) {
          if (tgt.classList && tgt.classList.contains('rf-edit-icon')) {
            e.stopPropagation();
            startEdit(td, tr);
            return;
          }
          tgt = tgt.parentElement;
        }
      });
    });
  }

  /* ────────────────────────────────────────────────────────────
     DETERMINE CELL CLASS & IDs
     ──────────────────────────────────────────────────────────── */
  function cellClass(td) {
    /* Return the primary semantic class of a cell.
       Redmine adds the field name as first class on data cells. */
    var classes = td.className.split(/\s+/);
    for (var i = 0; i < classes.length; i++) {
      var c = classes[i];
      if (c && c !== 'odd' && c !== 'even' && c !== 'hascontextmenu' && c !== 'context-menu-selection') {
        return c;
      }
    }
    return null;
  }

  function issueIdFromRow(tr) {
    var idTd = tr.querySelector('td.id');
    return idTd ? parseInt(idTd.textContent.trim(), 10) : null;
  }

  function projectIdFromRow(tr) {
    /* Try data attribute first, then look up project cell */
    if (tr.dataset.rfProjectId) return parseInt(tr.dataset.rfProjectId, 10);
    var pTd = tr.querySelector('td.project a');
    if (pTd) {
      /* Project link href often contains /projects/identifier */
      var href = pTd.getAttribute('href') || '';
      var m = href.match(/\/projects\/([^\/]+)/);
      if (m) {
        tr.dataset.rfProjectSlug = m[1];
      }
    }
    return null;
  }

  /* ────────────────────────────────────────────────────────────
     START EDIT — transform cell into an editor
     ──────────────────────────────────────────────────────────── */
  var _activeCancel = null; /* function to cancel the current open editor */

  function startEdit(td, tr) {
    /* Cancel any open editor first */
    if (_activeCancel) { _activeCancel(); _activeCancel = null; }

    var cls  = cellClass(td);
    var issueId  = issueIdFromRow(tr);
    if (!issueId) return;

    /* Lock the cell's current width so the table doesn't shift */
    var computedW = td.getBoundingClientRect().width;
    td.style.minWidth = computedW + 'px';
    td.style.width    = computedW + 'px';

    /* Remember original content for cancel.
       Reset icon opacity first so the captured snapshot has it hidden —
       the user just hovered and clicked so it may be at opacity 0.7. */
    var wrapper = td.querySelector('.rf-cell-wrapper');
    var _snapIcon = wrapper ? wrapper.querySelector('.rf-edit-icon') : null;
    if (_snapIcon) _snapIcon.style.opacity = '0';
    var originalHTML = wrapper ? wrapper.innerHTML : td.innerHTML;

    /* Mark row as editing to prevent context-menu interference */
    tr.classList.remove('hascontextmenu', 'context-menu-selection');
    var cbx = tr.querySelector('input[type="checkbox"][name="ids[]"]');
    if (cbx) cbx.checked = false;

    td.classList.add('rf-editing');

    /* ── Build the appropriate editor ── */
    var cls = cellClass(td);
    var cfMatch = td.className.match(/\bcf_(\d+)\b/);
    var cfId = cfMatch ? parseInt(cfMatch[1], 10) : null;

    function cancelEdit() {
      restoreCell(td, wrapper, originalHTML);
    }

    /* Set _activeCancel IMMEDIATELY — before any async data fetch.
       Without this, quickly clicking a second cell finds _activeCancel null
       (the first editor's fetch is still pending) and both editors open
       simultaneously once their fetches resolve. */
    _activeCancel = cancelEdit;

    buildEditor(td, tr, cls, cfId, issueId, cancelEdit);
  }

  function restoreCell(td, wrapper, originalHTML) {
    td.classList.remove('rf-editing');
    td.style.minWidth = '';
    td.style.width    = '';
    if (wrapper) {
      wrapper.innerHTML = originalHTML;
      /* buildEditor detaches wrapper from td (replaces it with a loaderWrap).
         Re-insert it so the original display content is visible again. */
      if (!wrapper.parentElement) {
        td.innerHTML = '';
        td.appendChild(wrapper);
      }
    } else {
      td.innerHTML = originalHTML;
    }
    /* originalHTML was captured while the user was hovering (opacity 0.7).
       Reset the icon to hidden so it only appears on the next hover. */
    var iconEl = td.querySelector('.rf-edit-icon');
    if (iconEl) iconEl.style.opacity = '0';
    /* Restore .hascontextmenu so the three-dot action button works again.
       startEdit() removes this class to prevent right-click menu interference
       during editing; we must put it back when editing ends. */
    var row = td.closest('tr');
    if (row) row.classList.add('hascontextmenu');
    if (_activeCancel === null) return; /* already cancelled */
    _activeCancel = null;
  }

  /* ────────────────────────────────────────────────────────────
     BUILD EDITOR — route to correct control type
     ──────────────────────────────────────────────────────────── */
  function buildEditor(td, tr, cls, cfId, issueId, cancelFn) {
    /* Capture display text BEFORE the wrapper is swapped out.
       After td.replaceChild(loaderWrap, wrapper), .rf-cell-display is detached
       and td.textContent returns empty — pre-selection breaks for every field. */
    var _currentText = currentCellText(td);
    var _donePct     = parseDoneRatio(td);

    var wrapper = td.querySelector('.rf-cell-wrapper');

    /* Replace wrapper with a loading spinner while fetching data */
    var loaderWrap = document.createElement('div');
    loaderWrap.className = 'rf-cell-editor-wrap';
    loaderWrap.innerHTML = '<span class="rf-spinner"></span>';
    if (wrapper) { td.replaceChild(loaderWrap, wrapper); }
    else { td.innerHTML = ''; td.appendChild(loaderWrap); }

    /* Attach click-outside and escape handlers immediately — covers the
       loading-spinner phase so clicking outside while fetching still reverts.
       Only call cancelFn if still in editing mode — after a successful save,
       verifyAndRefreshCell removes rf-editing before these handlers can fire,
       so we must not revert the freshly-saved value in that case. */
    var disposeOutside = RfIE.onClickOutside(td, function () {
      dispose();
      if (td.classList.contains('rf-editing')) cancelFn();
    });
    var disposeEsc = RfIE.onEscape(function () {
      dispose();
      if (td.classList.contains('rf-editing')) cancelFn();
    });

    function dispose() {
      disposeOutside();
      disposeEsc();
      _activeCancel = null;
    }

    _activeCancel = function () { dispose(); cancelFn(); };

    function renderEditor(editorEl) {
      /* If the edit was cancelled while waiting for async data (user clicked
         a different cell before this fetch completed), abort silently. */
      if (!td.classList.contains('rf-editing')) return;

      loaderWrap.innerHTML = '';
      loaderWrap.appendChild(editorEl);
    }

    /* ── Route by column type ── */
    if (cls === 'status') {
      fetchStatuses(issueId, function (statuses) {
        var sel = buildSelect(statuses, _currentText, function (id) {
          saveIssue(td, tr, issueId, { 'issue[status_id]': id }, null, cancelFn, function (data) {
            return data && data.issue && data.issue.status ? escHtml(data.issue.status.name) : null;
          });
        });
        renderEditor(sel);
      });
      return;
    }

    if (cls === 'priority') {
      fetchPriorities(function (priorities) {
        var sel = buildSelect(priorities, _currentText, function (id) {
          saveIssue(td, tr, issueId, { 'issue[priority_id]': id }, null, cancelFn, function (data) {
            return data && data.issue && data.issue.priority ? escHtml(data.issue.priority.name) : null;
          });
        });
        renderEditor(sel);
      });
      return;
    }

    if (cls === 'tracker') {
      fetchTrackers(tr, issueId, function (trackers) {
        var sel = buildSelect(trackers, _currentText, function (id) {
          saveIssue(td, tr, issueId, { 'issue[tracker_id]': id }, null, cancelFn, function (data) {
            return data && data.issue && data.issue.tracker ? escHtml(data.issue.tracker.name) : null;
          });
        });
        renderEditor(sel);
      });
      return;
    }

    if (cls === 'assigned_to') {
      fetchMembers(tr, issueId, function (members) {
        var ss = buildSearchableSelect(members, _currentText, true, function (id) {
          saveIssue(td, tr, issueId, { 'issue[assigned_to_id]': id }, null, cancelFn, function (data) {
            var u = data && data.issue && data.issue.assigned_to;
            return u ? '<a href="' + BASE + '/users/' + u.id + '">' + escHtml(u.name) + '</a>' : '—';
          });
        });
        renderEditor(ss);
        ss.focusInput();
      });
      return;
    }

    if (cls === 'fixed_version') {
      fetchVersions(tr, issueId, function (versions) {
        var ss = buildSearchableSelect(versions, _currentText, true, function (id) {
          saveIssue(td, tr, issueId, { 'issue[fixed_version_id]': id }, null, cancelFn, function (data) {
            var v = data && data.issue && data.issue.fixed_version;
            return v ? '<a href="' + BASE + '/versions/' + v.id + '">' + escHtml(v.name) + '</a>' : '—';
          });
        });
        renderEditor(ss);
        ss.focusInput();
      });
      return;
    }

    if (cls === 'project') {
      fetchProjects(function (projects) {
        var ss = buildSearchableSelect(projects, _currentText, false, function (id) {
          saveIssue(td, tr, issueId, { 'issue[project_id]': id }, null, cancelFn, function (data) {
            var p = data && data.issue && data.issue.project;
            return p ? '<a href="' + BASE + '/projects/' + p.id + '">' + escHtml(p.name) + '</a>' : null;
          });
        });
        renderEditor(ss);
        ss.focusInput();
      });
      return;
    }

    if (cls === 'category') {
      fetchCategories(tr, issueId, function (cats) {
        var sel = buildSelect(cats, _currentText, function (id) {
          saveIssue(td, tr, issueId, { 'issue[category_id]': id }, null, cancelFn, function (data) {
            return data && data.issue && data.issue.category ? escHtml(data.issue.category.name) : '—';
          });
        }, true);
        renderEditor(sel);
      });
      return;
    }

    if (cls === 'subject') {
      var inp = buildTextInput(_currentText, false, function (val) {
        if (!val.trim()) {
          RfIE.toast.error(RfIE.i18n('subjectBlank'));
          cancelFn();
          return;
        }
        saveIssue(td, tr, issueId, { 'issue[subject]': val }, null, cancelFn, function (data) {
          return data && data.issue && data.issue.subject
            ? '<a href="' + BASE + '/issues/' + issueId + '">' + escHtml(data.issue.subject) + '</a>'
            : null;
        });
      });
      renderEditor(inp);
      inp.querySelector('input') && inp.querySelector('input').focus();
      return;
    }

    if (cls === 'start_date' || cls === 'due_date') {
      var fieldKey = cls === 'start_date' ? 'issue[start_date]' : 'issue[due_date]';
      var rawDate  = _currentText;
      var isoDate  = RfIE.dateUtils.toISO(rawDate);
      var inp2 = buildDateInput(isoDate, function (val) {
        var datePayload = {};
        datePayload[fieldKey] = val;
        saveIssue(td, tr, issueId, datePayload, null, cancelFn, function (data) {
          if (!data || !data.issue) return null;
          var iso = cls === 'start_date' ? data.issue.start_date : data.issue.due_date;
          return iso ? escHtml(RfIE.dateUtils.toDisplay(iso)) : '—';
        });
      });
      renderEditor(inp2);
      inp2.querySelector('input') && inp2.querySelector('input').focus();
      return;
    }

    if (cls === 'estimated_hours') {
      var hoursInput = buildNumberInput(parseHoursDisplay(_currentText), 0, null, 0.25, function (val) {
        saveIssue(td, tr, issueId, { 'issue[estimated_hours]': val }, null, cancelFn, function (data) {
          if (!data || !data.issue) return null;
          /* Prefer the server-formatted value (respects Setting.timespan_format,
             e.g. "5:30") so the post-save display matches what a page refresh
             would show — avoids the decimal-now/h:mm-after-refresh mismatch
             that previously corrupted re-edits. */
          return escHtml(data.issue.estimated_hours_formatted || String(data.issue.estimated_hours || ''));
        });
      });
      renderEditor(hoursInput);
      hoursInput.querySelector('input') && hoursInput.querySelector('input').focus();
      return;
    }

    if (cls === 'done_ratio') {
      var pctOpts = [];
      for (var p = 0; p <= 100; p += 10) { pctOpts.push({ id: p, name: p + ' %' }); }
      /* Pre-select using parsed numeric value — _currentText is empty for native
         Redmine cells because <p class="percent"> starts empty. */
      var pctSel = buildSelect(pctOpts, _donePct + ' %', function (val) {
        saveIssue(td, tr, issueId, { 'issue[done_ratio]': val }, null, cancelFn, function (data) {
          if (!data || !data.issue || data.issue.done_ratio === undefined) return null;
          return doneRatioHtml(data.issue.done_ratio);
        });
      });
      renderEditor(pctSel);
      return;
    }

    /* ── Custom fields ── */
    if (cfId) {
      buildCustomFieldEditor(td, tr, cfId, issueId, renderEditor, cancelFn, _currentText);
      return;
    }

    /* story_points (agile plugin) */
    if (cls === 'story_points') {
      fetchStoryPoints(function (opts) {
        var sel = buildSelect(opts, _currentText, function (id) {
          var found = opts.filter(function (o) { return String(o.id) === String(id); })[0];
          var name  = found ? escHtml(found.name) : (id ? escHtml(String(id)) : '—');
          saveIssue(td, tr, issueId, { 'issue[story_points]': id || '' }, null, cancelFn, function () {
            return name;
          });
        }, true);
        renderEditor(sel);
      });
      return;
    }

    /* sprint_craft (agile plugin) */
    if (cls === 'sprint_craft') {
      fetchSprints(tr, issueId, function (opts) {
        var sel = buildSelect(opts, _currentText, function (id) {
          var found = opts.filter(function (o) { return String(o.id) === String(id); })[0];
          var name  = found ? escHtml(found.name) : '—';
          saveIssue(td, tr, issueId, { 'issue[sprint_craft_id]': id || '' }, null, cancelFn, function () {
            return name;
          });
        }, true);
        renderEditor(sel);
      });
      return;
    }

    /* Fallback: text input */
    loaderWrap.remove();
    if (wrapper) td.appendChild(wrapper);
  }

  /* ────────────────────────────────────────────────────────────
     CUSTOM FIELD EDITOR
     ──────────────────────────────────────────────────────────── */
  function buildCustomFieldEditor(td, tr, cfId, issueId, renderEditor, cancelFn, currentText) {
    ensureCustomFields(function (cfields) {
      var cf = null;
      for (var i = 0; i < cfields.length; i++) {
        if (parseInt(cfields[i].id, 10) === cfId) { cf = cfields[i]; break; }
      }
      if (!cf) { cancelFn(); return; }

      var fmt    = cf.field_format;
      var multi  = cf.multiple;
      var vals   = cf.possible_values || [];
      var apiKey = 'issue[custom_field_values][' + cfId + ']';

      currentText = currentText || '';

      /* Convert a raw submitted value to the HTML we want to show in the cell.
         Used as fallback when the CF is not present in the GET response (e.g.
         the CF is not applicable to this issue's tracker — Redmine omits it). */
      function optimisticDisplay(value, lookupList) {
        if (value === null || value === undefined || value === '') return '—';
        if (fmt === 'progressbar') return doneRatioHtml(parseInt(value, 10) || 0);
        if (fmt === 'link') return RfIE.linkHtml(value, escHtml);
        if (fmt === 'bool') return (value === '1' || value === 1) ? 'Yes' : 'No';
        if (fmt === 'enumeration') {
          for (var ei = 0; ei < vals.length; ei++) {
            var ev = vals[ei];
            var evId = typeof ev === 'object' ? String(ev.id) : String(ev);
            if (String(value) === evId) {
              return escHtml(typeof ev === 'object' ? (ev.label || ev.name || evId) : String(ev));
            }
          }
        }
        if (fmt === 'date') return value ? escHtml(RfIE.dateUtils.toDisplay(String(value))) : '—';
        if (fmt === 'float') {
          var fo = parseFloat(value);
          return isNaN(fo) ? escHtml(String(value)) : escHtml(fo.toFixed(2));
        }
        if (Array.isArray(value)) {
          var optNames = lookupList ? idsToNames(value, lookupList) : value;
          return escHtml(optNames.join(', ')) || '—';
        }
        return escHtml(String(value));
      }

      /* Resolve an array of raw ids to their display names via a {id,name}
         lookup list (members/versions) — falls back to the raw id string
         when a match isn't found, e.g. a user removed from the project. */
      function idsToNames(ids, lookupList) {
        return ids.map(function (id) {
          for (var li = 0; li < lookupList.length; li++) {
            if (String(lookupList[li].id) === String(id)) return lookupList[li].name;
          }
          return String(id);
        });
      }

      /* Reverse of idsToNames — the cell's displayed text is a comma-joined
         list of NAMES (idsToNames' own output, shown after save), but
         RfIE.MultiSelect's selectedIds option needs the underlying ids to
         pre-check the right chips when the editor is reopened. Without this,
         re-opening a saved multi-value user/version field showed everything
         unchecked — the names in currentText never matched any id in
         lookupList, since MultiSelect compares selectedIds against
         lookupList[i].id, not lookupList[i].name. */
      function namesToIds(names, lookupList) {
        return names.map(function (name) {
          for (var li = 0; li < lookupList.length; li++) {
            if (lookupList[li].name === name) return String(lookupList[li].id);
          }
          return null;
        }).filter(function (id) { return id !== null; });
      }

      function saveAndUpdate(value, lookupList) {
        var payload = {};
        if (multi && Array.isArray(value)) {
          if (value.length === 0) {
            /* Clearing a multi-value field to zero selections must still
               send SOMETHING for this custom field, not an empty payload —
               an empty payload means this save's request body ends up with
               no "issue[...]" keys at all. That silently no-ops here (this
               field's clear is never actually recorded) and, worse, if the
               required-field precheck below then falls back to a real form
               resubmit (RfIE.submitEditFormWithFullCf/submitEditForm) with
               that same empty payload, the resubmit has no "issue" param at
               all — Rails' own params.require(:issue) raises "param is
               missing", surfaced to the user as a raw, meaningless error
               instead of the proper "can't be blank" validation message.
               The key MUST use the "[]" array-bracket suffix, not an indexed
               "[0]" — Rails' own form parser (and buildIssueBody below, for
               our own AJAX path) turns "foo[0]=x" into a HASH {"0"=>"x"},
               not an Array ["x"]. Redmine's own blank check
               (Array.wrap(value).detect(&:present?)) works correctly on a
               genuine Array but not on a Hash wrapped as one weird element,
               which is exactly what produced a confusing "is not included
               in the list" error instead of a clean "can't be blank" one
               when this used "[0]". */
            payload['issue[custom_field_values][' + cfId + '][]'] = '';
          } else {
            value.forEach(function (v, i) {
              payload['issue[custom_field_values][' + cfId + '][' + i + ']'] = v;
            });
          }
        } else {
          payload[apiKey] = value;
        }
        saveIssue(td, tr, issueId, payload, null, cancelFn, function (data) {
          if (data && data.issue && data.issue.custom_fields) {
            var cfs = data.issue.custom_fields;
            for (var j = 0; j < cfs.length; j++) {
              if (parseInt(cfs[j].id, 10) === cfId) {
                var v = cfs[j].value;
                if (v === null || v === undefined || v === '') return '—';
                if (Array.isArray(v)) {
                  var names = lookupList ? idsToNames(v, lookupList) : v;
                  return escHtml(names.join(', ')) || '—';
                }
                if (fmt === 'progressbar') return doneRatioHtml(parseInt(v, 10) || 0);
                if (fmt === 'link' && v) return RfIE.linkHtml(v, escHtml);
                if (fmt === 'bool') return (v === '1' || v === 1 || v === true) ? 'Yes' : 'No';
                if (fmt === 'date') return v ? escHtml(RfIE.dateUtils.toDisplay(String(v))) : '—';
                if (fmt === 'enumeration') {
                  /* Server returns the raw stored ID; look up the label from the CF definition. */
                  for (var ei2 = 0; ei2 < vals.length; ei2++) {
                    var ev2 = vals[ei2];
                    var evId2 = typeof ev2 === 'object' ? String(ev2.id) : String(ev2);
                    if (String(v) === evId2) {
                      return escHtml(typeof ev2 === 'object' ? (ev2.label || ev2.name || evId2) : String(ev2));
                    }
                  }
                  return escHtml(String(v)); /* ID not found in vals — show raw as fallback */
                }
                if (fmt === 'float') {
                  var fv = parseFloat(v);
                  return isNaN(fv) ? escHtml(String(v)) : escHtml(fv.toFixed(2));
                }
                return escHtml(String(v));
              }
            }
          }
          /* CF absent from GET response — show optimistic value from selection */
          return optimisticDisplay(value, lookupList);
        });
      }

      if (fmt === 'enumeration') {
        var enumOpts = vals.map(function (v) {
          return typeof v === 'object' ? { id: v.id, name: v.label || v.name } : { id: v, name: String(v) };
        });
        var enumSel = buildSelect(enumOpts, currentText, function (id) {
          saveAndUpdate(id);
        }, true);
        renderEditor(enumSel);
        return;
      }

      if (fmt === 'bool') {
        /* A blank-option choice should be offered whenever the field is optional,
           EXCEPT for edit_tag_style 'check_box' — that style is Redmine's own
           single_check_box_edit_tag (lib/redmine/field_format.rb), a single
           Yes/No toggle with no third state to represent blank, regardless of
           is_required. Dropdown (edit_tag_style '' / falsy) and 'radio' both
           go through the shared check_box_edit_tag/select_edit_tag helpers,
           which DO add a blank/"(none)" option whenever the field isn't
           required — radio was previously (wrongly) grouped with check_box
           here, which hid an otherwise-available None option for an optional
           radio-style bool CF on this list page. */
        var boolAllowBlank = cf.edit_tag_style !== 'check_box' && !cf.is_required;
        var boolCurrent = currentText === 'Yes' ? 'Yes' : (currentText === 'No' ? 'No' : currentText);
        var boolSel = buildSelect([{ id: '1', name: 'Yes' }, { id: '0', name: 'No' }],
          boolCurrent, function (id) {
            saveAndUpdate(id);
          }, boolAllowBlank);
        renderEditor(boolSel);
        return;
      }

      if (fmt === 'list') {
        var listOpts = vals.map(function (v) { return { id: v, name: v }; });
        if (multi) {
          /* A bare native <select multiple> (the old buildMultiSelect helper)
             has no custom styling and, for a List CF with only one or two
             configured options, renders as a cramped listbox that's easy to
             mistake for a broken control rather than an actual dropdown.
             RfIE.MultiSelect — the chip + searchable-checkbox widget already
             used for this exact "pick zero or more of N options" shape on the
             issue DETAIL page (buildMultiSelectUI in
             rf_inline_editor_issue_show.js) — is the correct control here.
             RfIE.onClickOutside (rf_inline_editor_core.js) already special-
             cases '.rf-ms__dropdown' so its portaled option list doesn't
             trigger a false "clicked outside, cancel the edit". Because
             selection here happens via several chip/checkbox toggles rather
             than one native 'change' event, there's no single moment to
             auto-save on — so, mirroring the detail page's own confirm/
             discard affordance for this same widget, a small inline
             check/cancel icon pair commits or discards the edit. */
          var currentVals = currentText.split(/,\s*/).filter(function (v) { return v !== ''; });
          var ms = new RfIE.MultiSelect(listOpts, {
            selectedIds: currentVals,
            minWidth: '160px'
          });
          renderEditor(buildMultiSelectEditorWrap(ms, function () { saveAndUpdate(ms.getValues()); }, cancelFn));
          ms.focusInput();
        } else {
          var sel2 = buildSelect(listOpts, currentText, function (id) {
            saveAndUpdate(id);
          }, true);
          renderEditor(sel2);
        }
        return;
      }

      if (fmt === 'user') {
        fetchMembers(tr, issueId, function (members) {
          function memberHtml(userId) {
            if (!userId && userId !== 0) return '—';
            var found = null;
            for (var mi = 0; mi < members.length; mi++) {
              if (String(members[mi].id) === String(userId)) { found = members[mi]; break; }
            }
            if (!found) return escHtml(String(userId));
            return '<a href="' + BASE + '/users/' + escHtml(String(userId)) + '">' + escHtml(found.name) + '</a>';
          }
          /* "Multiple values" enabled — same RfIE.MultiSelect chip/checkbox
             widget 'list' format uses at its multi branch above, for a
             consistent look across every multi-value field on this page
             (a bare native <select multiple> here would be a visual
             regression next to 'list's polished picker). saveAndUpdate's
             multi && Array.isArray(value) branch already builds the
             issue[custom_field_values][id][index] array payload generically
             (see saveAndUpdate above), so no new save-path code is needed. */
          if (multi) {
            var currentUserNames = currentText.split(/,\s*/).filter(function (v) { return v !== ''; });
            var currentUserVals = namesToIds(currentUserNames, members);
            var ums = new RfIE.MultiSelect(members, {
              selectedIds: currentUserVals,
              minWidth: '160px'
            });
            renderEditor(buildMultiSelectEditorWrap(ums, function () { saveAndUpdate(ums.getValues(), members); }, cancelFn));
            ums.focusInput();
            return;
          }
          /* the blank option must only be offered when the field is optional —
             matches the already-established allowBlank: !cf.is_required
             pattern used elsewhere in this file (e.g. Boolean CFs above). */
          var ss = buildSearchableSelect(members, currentText, !cf.is_required, function (id) {
            var cfPayload = {};
            cfPayload[apiKey] = id;
            saveIssue(td, tr, issueId, cfPayload, null, cancelFn, function (data) {
              if (data && data.issue && data.issue.custom_fields) {
                var cfs2 = data.issue.custom_fields;
                for (var j = 0; j < cfs2.length; j++) {
                  if (parseInt(cfs2[j].id, 10) === cfId) return memberHtml(cfs2[j].value);
                }
              }
              return memberHtml(id); /* optimistic: use the selected ID */
            });
          });
          renderEditor(ss);
          ss.focusInput();
        });
        return;
      }

      if (fmt === 'version') {
        fetchVersions(tr, issueId, function (versions) {
          function versionHtml(versionId) {
            if (!versionId && versionId !== 0) return '—';
            var found = null;
            for (var vi = 0; vi < versions.length; vi++) {
              if (String(versions[vi].id) === String(versionId)) { found = versions[vi]; break; }
            }
            if (!found) return escHtml(String(versionId));
            return '<a href="' + BASE + '/versions/' + escHtml(String(versionId)) + '">' + escHtml(found.name) + '</a>';
          }
          /* Same multi-value handling as 'user' above — see comment there. */
          if (multi) {
            var currentVersionNames = currentText.split(/,\s*/).filter(function (v) { return v !== ''; });
            var currentVersionVals = namesToIds(currentVersionNames, versions);
            var vms = new RfIE.MultiSelect(versions, {
              selectedIds: currentVersionVals,
              minWidth: '160px'
            });
            renderEditor(buildMultiSelectEditorWrap(vms, function () { saveAndUpdate(vms.getValues(), versions); }, cancelFn));
            vms.focusInput();
            return;
          }
          var ss = buildSearchableSelect(versions, currentText, !cf.is_required, function (id) {
            var cfPayload = {};
            cfPayload[apiKey] = id;
            saveIssue(td, tr, issueId, cfPayload, null, cancelFn, function (data) {
              if (data && data.issue && data.issue.custom_fields) {
                var cfs2 = data.issue.custom_fields;
                for (var j = 0; j < cfs2.length; j++) {
                  if (parseInt(cfs2[j].id, 10) === cfId) return versionHtml(cfs2[j].value);
                }
              }
              return versionHtml(id); /* optimistic: use the selected ID */
            });
          });
          renderEditor(ss);
          ss.focusInput();
        });
        return;
      }

      if (fmt === 'date') {
        var isoVal = RfIE.dateUtils.toISO(currentText);
        var dateInp = buildDateInput(isoVal, function (val) { saveAndUpdate(val); });
        renderEditor(dateInp);
        dateInp.querySelector('input') && dateInp.querySelector('input').focus();
        return;
      }

      if (fmt === 'text') {
        var ta = buildTextareaInput(currentText, function (val) { saveAndUpdate(val); });
        renderEditor(ta);
        ta.querySelector('textarea') && ta.querySelector('textarea').focus();
        return;
      }

      if (fmt === 'int' || fmt === 'float') {
        /* Use a plain text input, NOT <input type="number"> (bug 15 / bug 13-14
           parity with the detail page). A native number input silently
           sanitizes invalid keystrokes — typing "abc" or a second "." in a
           number field never reaches this handler as that literal text; the
           browser coerces .value to '' first, so an out-of-format entry gets
           submitted (and saved) as a blank clear with no error, instead of
           being rejected. Redmine's own issue form renders int/float custom
           fields as plain text inputs too (Base#edit_tag in lib/redmine/
           field_format.rb uses text_field_tag; IntFormat/FloatFormat never
           override it), and the detail page's inline editor clones that same
           native text input — so this also matches the control the server's
           format/required/min-max-length validation (IssueTablesController
           #update_issue_field's custom_field_values re-validation block) was
           already written to handle correctly. */
        var numInp = buildTextInput(currentText, false, function (val) {
          saveAndUpdate(val);
        });
        renderEditor(numInp);
        numInp.querySelector('input') && numInp.querySelector('input').focus();
        return;
      }

      if (fmt === 'progressbar') {
        /* vals (cf.possible_values) is populated server-side (see
           IssueTablesController#all_custom_fields) as the real 0..100 step
           list generated from this CF's configured "Ratio interval"
           (cf.ratio_interval) — mirroring core's own edit_tag. Use it
           directly instead of a hardcoded 10% step so the dropdown matches
           whatever interval was configured (e.g. 5%). */
        var pbOpts = vals.map(function (v) {
          return typeof v === 'object' ? { id: v.id, name: v.label } : { id: v, name: v + ' %' };
        });
        if (!pbOpts.length) {
          for (var pi = 0; pi <= 100; pi += 10) { pbOpts.push({ id: pi, name: pi + ' %' }); }
        }
        var pbRaw = parseInt(currentText, 10) || 0;
        var pbClosest = pbOpts[0];
        var pbClosestDiff = Math.abs(pbRaw - (parseInt(pbClosest.id, 10) || 0));
        for (var pj = 1; pj < pbOpts.length; pj++) {
          var pbDiff = Math.abs(pbRaw - (parseInt(pbOpts[pj].id, 10) || 0));
          if (pbDiff < pbClosestDiff) { pbClosestDiff = pbDiff; pbClosest = pbOpts[pj]; }
        }
        var pbSel = buildSelect(pbOpts, pbClosest.name, function (val) {
          saveAndUpdate(val);
        });
        renderEditor(pbSel);
        return;
      }

      if (fmt === 'attachment') {
        cancelFn();
        return;
      }

      /* Default: text (string, link, etc.) */
      var txtInp = buildTextInput(currentText, false, function (val) { saveAndUpdate(val); });
      renderEditor(txtInp);
      txtInp.querySelector('input') && txtInp.querySelector('input').focus();
    });
  }

  /* ────────────────────────────────────────────────────────────
     SAVE LOGIC
     ──────────────────────────────────────────────────────────── */
  function saveIssue(td, tr, issueId, payload, displayText, cancelFn, getDisplayFromResponse) {
    td.classList.add('rf-saving');

    /* Swap editor content for a spinner so the user sees immediate feedback */
    var editorWrap = td.querySelector('.rf-cell-editor-wrap');
    if (editorWrap) {
      editorWrap.innerHTML =
        '<span class="rf-spinner"></span>' +
        '<span class="rf-saving-text">' + RfIE.i18n('saving') + '</span>';
    }

    /* Use our own endpoint so that required-field validations on OTHER fields
       (e.g. "Float issue field cannot be blank") do not block a single-field
       inline edit.  save(validate: false) runs on the server side, bypassing
       unrelated validations while still recording a proper journal entry. */
    RfIE.api.put(BASE + '/issues/' + issueId + '/update_field', buildIssueBody(payload))
      .then(function (data) {
        td.classList.remove('rf-saving');
        _activeCancel = null;
        RfIE.toast.success(RfIE.i18n('changesSavedSuccessfully'));

        /* Invalidate this issue's cached workflow-allowed statuses. The list
           returned by fetch_issue_allowed_status depends on the issue's CURRENT
           status and tracker (Issue#new_statuses_allowed_to), so ANY successful
           save on this issue (status change, tracker change, etc.) can change
           what transitions are valid next. Without this, reopening the Status
           cell later in the same page session reuses the stale list fetched
           before this save, showing options that violate the workflow until a
           full page reload clears the in-memory cache. */
        delete _cache.statuses[issueId];

        /* update_issue_field returns { issue: { id, custom_fields: [...] } }.
           For CF saves the display value can be derived directly from the PUT
           response — this avoids an extra GET round-trip that can return stale
           cached data and cause the old value to persist until page refresh. */
        var quickText = null;
        if (data && data.issue) {
          try { quickText = getDisplayFromResponse(data); } catch (e) {}
        }
        if (quickText !== null) {
          refreshCellDisplay(td, quickText);
        } else {
          verifyAndRefreshCell(td, tr, issueId, getDisplayFromResponse, cancelFn);
        }
      })
      .catch(function (err) {
        /* Some OTHER field on this issue is a blank required field —
           update_field.json refused to save and asked us to resubmit through
           Redmine's own update action so its native full-page
           validation-error rendering takes over (see RfIE.submitEditForm),
           rather than us trying to explain the failure ourselves in a toast
           for a field that itself was actually valid (see
           issue_tables_controller.rb). */
        if (err && err.redirect_to_edit) {
          RfIE.submitEditFormWithFullCf(BASE + '/issues/' + issueId, BASE + '/issues/' + issueId + '/rf_issue', 'issue', payload);
          return;
        }
        td.classList.remove('rf-saving');
        RfIE.toast.error(extractErrorMessage(err));
        if (cancelFn) cancelFn();
      });
  }

  /* Shared helper: replace cell content with a fresh display + pencil icon. */
  function refreshCellDisplay(td, newText) {
    td.classList.remove('rf-editing');
    td.style.minWidth = '';
    td.style.width    = '';

    var wrapper = document.createElement('span');
    wrapper.className = 'rf-cell-wrapper';

    var display = document.createElement('span');
    display.className = 'rf-cell-display';
    /* Use innerHTML so link fields (assignee, version, project, subject)
       restore as <a> elements rather than plain text. Callers are responsible
       for returning safe HTML or escHtml-escaped text. */
    display.innerHTML = newText !== null ? newText : '—';

    var icon = RfIE.dom.editIcon();
    wrapper.appendChild(display);
    wrapper.appendChild(icon);
    td.innerHTML = '';
    td.appendChild(wrapper);
    /* Hover and click handlers remain on td from decorateRow — no re-attach needed. */

    /* Restore .hascontextmenu so the three-dot action button works after a save.
       startEdit() removes this class to prevent right-click menu interference
       during editing; we must put it back once the cell is restored. */
    var row = td.closest('tr');
    if (row) row.classList.add('hascontextmenu');
  }

  function verifyAndRefreshCell(td, tr, issueId, getDisplayFromResponse, cancelFn) {
    RfIE.api.get(BASE + '/issues/' + issueId + '/rf_issue')
      .then(function (data) {
        var newText = null;
        try { newText = getDisplayFromResponse(data); } catch (e) {}
        refreshCellDisplay(td, newText);
      })
      .catch(function () {
        if (cancelFn) cancelFn();
      });
  }

  /* Convert flat key→value payload to Redmine nested JSON */
  function buildIssueBody(payload) {
    var issue = {};
    Object.keys(payload).forEach(function (k) {
      /* Parse "issue[custom_field_values][3]" → nested object.
         The last bracket group is "\d*" (zero-or-more), not "\d+", so it
         also matches an empty "[]" suffix — e.g.
         "issue[custom_field_values][5][]", used to clear a multi-value
         field to zero selections (see saveAndUpdate) — not just numeric
         indices like "[0]"/"[1]". Without "*" that key fails to match at
         all and gets silently dropped by the `if (!m) return;` below. */
      var m = k.match(/^issue\[(.+?)\](?:\[(.+?)\])?(?:\[(\d*)\])?$/);
      if (!m) return;
      if (m[1] === 'custom_field_values') {
        /* Redmine safe_attributes= expects custom_field_values as a Hash
           {"cf_id" => value}, NOT an Array [{id,value}].
           Using an Array causes `stringify_keys on []:Array` in Rails. */
        var cfId2 = m[2];
        var cfIdx = m[3];
        if (!issue.custom_field_values) issue.custom_field_values = {};
        if (cfIdx != null) {
          /* Multi-select: issue[custom_field_values][1][0], [1], … */
          if (!Array.isArray(issue.custom_field_values[cfId2])) {
            issue.custom_field_values[cfId2] = [];
          }
          issue.custom_field_values[cfId2].push(payload[k]);
        } else {
          issue.custom_field_values[cfId2] = payload[k];
        }
      } else {
        /* Simple "issue[field_name]" */
        issue[m[1]] = payload[k];
      }
    });
    return { issue: issue };
  }

  function extractErrorMessage(err) {
    if (!err) return RfIE.i18n('unexpectedError');
    if (typeof err === 'string') return err;
    /* Structured server error — show the actual validation message */
    if (err.errors && Array.isArray(err.errors) && err.errors.length) {
      return err.errors.join(' ');
    }
    /* HTTP status codes from the API client */
    if (err.message) {
      var m = err.message;
      if (m === 'HTTP 403') return RfIE.i18n('noPermissionIssue');
      if (m === 'HTTP 404') return RfIE.i18n('issueNotFound');
      if (m === 'HTTP 422') return RfIE.i18n('changeNotSaved');
      if (m === 'HTTP 500') return RfIE.i18n('serverError');
      if (m.indexOf('Failed to fetch') >= 0 || m.indexOf('NetworkError') >= 0) {
        return RfIE.i18n('connectionError');
      }
    }
    return RfIE.i18n('genericSaveError');
  }

  /* ────────────────────────────────────────────────────────────
     CONTROL BUILDERS
     ──────────────────────────────────────────────────────────── */

  /** Build a <select> element that auto-saves on change. */
  function buildSelect(options, currentText, onChange, allowBlank) {
    var wrap = document.createElement('div');
    wrap.className = 'rf-cell-editor-wrap';

    var sel = document.createElement('select');
    sel.className = 'rf-select';

    /* Detect a "blank" display value so the None option can be pre-selected */
    var isBlankValue = !currentText || currentText === '—' || currentText === '-' || currentText === '';

    if (allowBlank) {
      var blank = document.createElement('option');
      blank.value = '';
      blank.textContent = RfIE.i18n('none');
      if (isBlankValue) blank.selected = true;
      sel.appendChild(blank);
    }

    var matchedId = null;
    options.forEach(function (opt) {
      var o = document.createElement('option');
      o.value = opt.id;
      o.textContent = opt.name;
      if (opt.name === currentText) {
        o.selected = true;
        matchedId = opt.id;
      }
      sel.appendChild(o);
    });

    sel.addEventListener('change', function () {
      /* Always fire onChange, including when the user selects the blank
         the blank option (value === ''). That option only exists when
         allowBlank is true (i.e. the field is legitimately clearable), so
         guarding it out here silently prevented users from ever clearing
         a Category (or other allowBlank) field via this control. */
      onChange(sel.value);
    });

    /* Escape key cancels — let the outer Escape handler deal with it */
    sel.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); onChange(sel.value); }
    });

    wrap.appendChild(sel);
    sel.focus();
    return wrap;
  }

  /** Build a multi-select control that auto-saves on change. */
  /** Wrap an RfIE.MultiSelect (chip + searchable-checkbox widget) with an
   *  inline confirm/discard icon pair, for any "pick zero or more of N
   *  options" cell editor on this page (list/user/version formats with
   *  Multiple values enabled). Selection here happens via several
   *  chip/checkbox toggles rather than one native 'change' event, so
   *  there's no single moment to auto-save on — mirrors the issue DETAIL
   *  page's identical confirm/discard affordance for this same widget
   *  (buildMultiSelectUI in rf_inline_editor_issue_show.js). */
  function buildMultiSelectEditorWrap(ms, onSave, onCancel) {
    var wrap = document.createElement('div');
    wrap.className = 'rf-cell-editor-wrap';

    var row = document.createElement('div');
    row.className = 'rf-ms-row';

    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'rf-icon-btn rf-icon-btn--cancel';
    cancelBtn.innerHTML = RfIE.icons.x;
    cancelBtn.setAttribute('aria-label', 'Cancel');
    cancelBtn.addEventListener('mousedown', function (e) { e.preventDefault(); });
    cancelBtn.addEventListener('click', onCancel);

    var saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'rf-icon-btn rf-icon-btn--save';
    saveBtn.innerHTML = RfIE.icons.check;
    saveBtn.setAttribute('aria-label', 'Save');
    saveBtn.addEventListener('mousedown', function (e) { e.preventDefault(); });
    saveBtn.addEventListener('click', onSave);

    row.appendChild(ms);
    row.appendChild(cancelBtn);
    row.appendChild(saveBtn);
    wrap.appendChild(row);
    return wrap;
  }

  /** Build a searchable select widget (assigned_to, version, project). */
  function buildSearchableSelect(options, currentText, allowBlank, onChange) {
    var wrap = document.createElement('div');
    wrap.className = 'rf-cell-editor-wrap';

    var isBlankValue = !currentText || currentText === '—' || currentText === '-' || currentText === '';
    var selectedOpt = isBlankValue ? null : options.filter(function (o) { return o.name === currentText; })[0];
    var ss = new RfIE.SearchableSelect(options, {
      selectedId:  selectedOpt ? selectedOpt.id : null,
      allowBlank:  allowBlank,
      minWidth:    '140px',
      onSelect: function (id) {
        onChange(id);
      }
    });
    wrap.appendChild(ss);

    /* Proxy SearchableSelect methods so callers can do wrap.focusInput() etc. */
    wrap.focusInput = function () { ss.focusInput(); };
    wrap.getValue   = function () { return ss.getValue(); };
    wrap.getName    = function () { return ss.getName(); };

    return wrap;
  }

  /** Build a plain text input. Enter saves. */
  function buildTextInput(currentVal, isMultiLine, onChange) {
    var wrap = document.createElement('div');
    wrap.className = 'rf-cell-editor-wrap';

    var inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'rf-input';
    inp.value = currentVal || '';

    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        onChange(inp.value.trim());
      }
    });

    wrap.appendChild(inp);
    return wrap;
  }

  /** Build a textarea. Enter (without Shift) saves. */
  function buildTextareaInput(currentVal, onChange) {
    var wrap = document.createElement('div');
    wrap.className = 'rf-cell-editor-wrap';

    var ta = document.createElement('textarea');
    ta.className = 'rf-textarea';
    ta.value = currentVal || '';
    ta.rows = 3;

    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        onChange(ta.value.trim());
      }
    });

    wrap.appendChild(ta);
    return wrap;
  }

  /** Build a date input. */
  function buildDateInput(isoDate, onChange) {
    var wrap = document.createElement('div');
    wrap.className = 'rf-cell-editor-wrap';

    var inp = document.createElement('input');
    inp.type = 'date';
    inp.className = 'rf-input';
    inp.value = isoDate || '';

    /* Always forward the value, including an empty string — clearing the date
       (removing the text or clearing via the picker) must be sendable as a
       real "blank this field" save, not silently dropped. Matches the issue
       SHOW page's date handling (sanitizeClone's clone.type === 'date' branch
       in rf_inline_editor_issue_show.js), which sends `value: clone.value`
       unconditionally. */
    RfIE.bindDateInput(inp, onChange);

    wrap.appendChild(inp);
    return wrap;
  }

  /** Build a numeric input. */
  function buildNumberInput(currentVal, min, max, step, onChange) {
    var wrap = document.createElement('div');
    wrap.className = 'rf-cell-editor-wrap';

    var inp = document.createElement('input');
    inp.type = 'number';
    inp.className = 'rf-input';
    inp.value = currentVal || '';
    if (min !== null && min !== undefined) inp.min  = min;
    if (max !== null && max !== undefined) inp.max  = max;
    if (step) inp.step = step;

    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        onChange(inp.value);
      }
    });

    wrap.appendChild(inp);
    return wrap;
  }

  /* ────────────────────────────────────────────────────────────
     DATA FETCHERS
     ──────────────────────────────────────────────────────────── */

  function fetchStatuses(issueId, cb) {
    if (_cache.statuses[issueId]) return cb(_cache.statuses[issueId]);
    RfIE.api.get(BASE + '/issues/' + issueId + '/allowed_status')
      .then(function (data) {
        var list = (data.allowed_status || []).map(function (s) { return { id: s.id, name: s.name }; });
        _cache.statuses[issueId] = list;
        cb(list);
      })
      .catch(function () { cb([]); });
  }

  function fetchPriorities(cb) {
    if (_cache.priorities) return cb(_cache.priorities);
    RfIE.api.get(BASE + '/rf_issue_priorities')
      .then(function (data) {
        var list = (data.issue_priorities || []).map(function (p) { return { id: p.id, name: p.name }; });
        _cache.priorities = list;
        cb(list);
      })
      .catch(function () {
        /* Fallback: try to read priorities from the DOM (issue form) */
        var opts = document.querySelectorAll('#issue_priority_id option');
        var list = [];
        opts.forEach(function (o) { if (o.value) list.push({ id: o.value, name: o.textContent.trim() }); });
        _cache.priorities = list;
        cb(list);
      });
  }

  /* Fetch trackers enabled for the issue's project.
     Redmine only allows trackers that are enabled in Project Settings → Trackers.
     Sending a tracker outside that set causes 422 "Tracker is not included in the list". */
  function fetchTrackers(tr, issueId, cb) {
    var projId = tr.dataset.rfProjectId;
    if (projId) return _fetchTrackersForProject(projId, cb);

    /* Project ID not yet known — resolve it from the issue */
    RfIE.api.get(BASE + '/issues/' + issueId + '/rf_issue')
      .then(function (data) {
        var pid = data.issue && data.issue.project ? data.issue.project.id : null;
        if (!pid) { cb([]); return; }
        tr.dataset.rfProjectId = pid;
        _fetchTrackersForProject(pid, cb);
      })
      .catch(function () { cb([]); });
  }

  function _fetchTrackersForProject(projId, cb) {
    if (_cache.trackers[projId]) return cb(_cache.trackers[projId]);
    RfIE.api.get(BASE + '/projects/' + projId + '/rf_project?include=trackers')
      .then(function (data) {
        var list = ((data.project && data.project.trackers) || [])
          .map(function (t) { return { id: t.id, name: t.name }; });
        _cache.trackers[projId] = list;
        cb(list);
      })
      .catch(function () { cb([]); });
  }

  function fetchMembers(tr, issueId, cb) {
    /* First try to get project id from data attribute or from issue GET */
    var projId = tr.dataset.rfProjectId;
    if (projId) {
      return _fetchMembersForProject(projId, cb);
    }
    /* Get from issue detail */
    RfIE.api.get(BASE + '/issues/' + issueId + '/rf_issue')
      .then(function (data) {
        var pid = data.issue && data.issue.project ? data.issue.project.id : null;
        if (!pid) { cb([]); return; }
        tr.dataset.rfProjectId = pid;
        _fetchMembersForProject(pid, cb);
      })
      .catch(function () { cb([]); });
  }

  function _fetchMembersForProject(projId, cb) {
    if (_cache.members[projId]) return cb(_cache.members[projId]);
    RfIE.api.get(BASE + '/projects/' + projId + '/active_members')
      .then(function (data) {
        var list = (data.active_members || []).map(function (m) { return { id: m.id, name: m.name }; });
        _cache.members[projId] = list;
        cb(list);
      })
      .catch(function () { cb([]); });
  }

  function fetchVersions(tr, issueId, cb) {
    var projId = tr.dataset.rfProjectId;
    if (projId) {
      return _fetchVersionsForProject(projId, cb);
    }
    RfIE.api.get(BASE + '/issues/' + issueId + '/rf_issue')
      .then(function (data) {
        var pid = data.issue && data.issue.project ? data.issue.project.id : null;
        if (!pid) { cb([]); return; }
        tr.dataset.rfProjectId = pid;
        _fetchVersionsForProject(pid, cb);
      })
      .catch(function () { cb([]); });
  }

  function _fetchVersionsForProject(projId, cb) {
    if (_cache.versions[projId]) return cb(_cache.versions[projId]);
    RfIE.api.get(BASE + '/' + projId + '/all_versions?indata=yes')
      .then(function (data) {
        var list = (data.version || []).map(function (v) { return { id: v.id, name: v.name }; });
        _cache.versions[projId] = list;
        cb(list);
      })
      .catch(function () { cb([]); });
  }

  function fetchProjects(cb) {
    if (_cache.projects) return cb(_cache.projects);
    RfIE.api.get(BASE + '/all_projects')
      .then(function (data) {
        var list = (data.projects || []).map(function (p) { return { id: p.id, name: p.name }; });
        _cache.projects = list;
        cb(list);
      })
      .catch(function () { cb([]); });
  }

  function fetchCategories(tr, issueId, cb) {
    var projId = tr.dataset.rfProjectId;
    if (!projId) {
      RfIE.api.get(BASE + '/issues/' + issueId + '/rf_issue')
        .then(function (data) {
          var pid = data.issue && data.issue.project ? data.issue.project.id : null;
          if (!pid) { cb([]); return; }
          tr.dataset.rfProjectId = pid;
          _fetchCategoriesForProject(pid, cb);
        }).catch(function () { cb([]); });
    } else {
      _fetchCategoriesForProject(projId, cb);
    }
  }

  function _fetchCategoriesForProject(projId, cb) {
    if (_cache.categories && _cache.categories[projId]) return cb(_cache.categories[projId]);
    RfIE.api.get(BASE + '/projects/' + projId + '/rf_issue_categories')
      .then(function (data) {
        var list = (data.issue_categories || []).map(function (c) { return { id: c.id, name: c.name }; });
        if (!_cache.categories) _cache.categories = {};
        _cache.categories[projId] = list;
        cb(list);
      })
      .catch(function () { cb([]); });
  }

  function fetchStoryPoints(cb) {
    if (_cache.storyPoints) return cb(_cache.storyPoints);

    /* 1. Try native form select (present on issue show/edit pages) */
    var sp = document.querySelector('select[name="issue[story_points]"]');
    if (sp && sp.querySelectorAll('option[value]').length > 0) {
      var fromSelect = [];
      sp.querySelectorAll('option').forEach(function (o) {
        if (o.value !== '') fromSelect.push({ id: o.value, name: o.textContent.trim() });
      });
      if (fromSelect.length) {
        _cache.storyPoints = fromSelect;
        return cb(fromSelect);
      }
    }

    /* 2. Fetch from our own endpoint that reads Setting.plugin_agile_board */
    RfIE.api.get(BASE + '/agile_story_points')
      .then(function (data) {
        var list = buildStoryPointList(data && data.story_point_values);
        _cache.storyPoints = list;
        cb(list);
      })
      .catch(function () {
        var list = buildStoryPointList(null);
        _cache.storyPoints = list;
        cb(list);
      });
  }

  function buildStoryPointList(values) {
    var arr = Array.isArray(values) ? values : ['0','1','2','3','5','8','13','21','34','55','89'];
    return arr.map(function (v) {
      var n = String(v).trim();
      return n ? { id: n, name: n } : null;
    }).filter(Boolean);
  }

  function fetchSprints(tr, issueId, cb) {
    /* 1. Try native form select (present on issue show/edit pages) */
    var sp = document.querySelector('#issue_sprint_craft_id') ||
             document.querySelector('select[name="issue[sprint_craft_id]"]');
    if (sp && sp.querySelectorAll('option[value]').length > 0) {
      var fromSelect = [];
      sp.querySelectorAll('option').forEach(function (o) {
        if (o.value !== '') fromSelect.push({ id: o.value, name: o.textContent.trim() });
      });
      if (fromSelect.length) return cb(fromSelect);
    }

    /* 2. Fetch from agile plugin API — needs project id */
    var projId = tr && tr.dataset.rfProjectId;
    if (projId) return _fetchSprintsForProject(projId, cb);

    /* Resolve project id from issue */
    RfIE.api.get(BASE + '/issues/' + issueId + '/rf_issue')
      .then(function (data) {
        var pid = data.issue && data.issue.project ? String(data.issue.project.id) : null;
        if (!pid) { cb([]); return; }
        if (tr) tr.dataset.rfProjectId = pid;
        _fetchSprintsForProject(pid, cb);
      })
      .catch(function () { cb([]); });
  }

  function _fetchSprintsForProject(projId, cb) {
    if (_cache.sprints[projId]) return cb(_cache.sprints[projId]);
    RfIE.api.get(BASE + '/projects/' + projId + '/fetch_sprints')
      .then(function (data) {
        var list = (data.sprints || []).map(function (s) { return { id: String(s.id), name: s.name }; });
        _cache.sprints[projId] = list;
        cb(list);
      })
      .catch(function () { cb([]); });
  }

  function loadCustomFields() {
    if (_cache.cfields !== null) return;
    RfIE.api.get(BASE + '/all_custom_fields')
      .then(function (data) {
        _cache.cfields = Array.isArray(data) ? data : [];
      })
      .catch(function () {
        _cache.cfields = [];
      });
  }

  function ensureCustomFields(cb) {
    if (_cache.cfields !== null) { cb(_cache.cfields); return; }
    RfIE.api.get(BASE + '/all_custom_fields')
      .then(function (data) {
        _cache.cfields = Array.isArray(data) ? data : [];
        cb(_cache.cfields);
      })
      .catch(function () {
        _cache.cfields = [];
        cb([]);
      });
  }

  /* ────────────────────────────────────────────────────────────
     HELPERS
     ──────────────────────────────────────────────────────────── */

  function currentCellText(td) {
    var display = td.querySelector('.rf-cell-display');
    if (display) return display.textContent.trim();
    var txt = td.querySelector('.td_text');
    if (txt) return txt.textContent.trim();
    return td.textContent.trim();
  }

  function parseDoneRatio(td) {
    /* 1. Redmine native: <td class="closed" title="30%"> */
    var closed = td.querySelector('.closed');
    if (closed && closed.title) return parseInt(closed.title, 10) || 0;
    /* 2. Our rebuilt cell: <p class="percent">30 %</p> */
    var pctEl = td.querySelector('p.percent');
    if (pctEl && pctEl.textContent) return parseInt(pctEl.textContent, 10) || 0;
    /* 3. Table class: <table class="progress progress-30"> */
    var tbl = td.querySelector('table.progress');
    if (tbl) {
      var m = (tbl.className || '').match(/progress-(\d+)/);
      if (m) return parseInt(m[1], 10) || 0;
    }
    /* 4. Fallback label */
    var label = td.querySelector('label');
    if (label) return parseInt(label.textContent, 10) || 0;
    return 0;
  }

  function trackerIdFromRow(tr) {
    var m = (tr.className || '').match(/\btracker-(\d+)\b/);
    return m ? parseInt(m[1], 10) : null;
  }

  function disableCFCell(cell) {
    cell.classList.add('rf-no-edit');
    var icon = cell.querySelector('.rf-edit-icon');
    if (icon) icon.style.display = 'none';
  }

  /* After decoration, hide pencil icons on CF cells that cannot be edited inline:
     1. attachment-type CFs — file uploads are not supported inline
     2. CFs whose tracker_ids list doesn't include this row's tracker
        (tracker_ids empty = applies to all trackers — leave enabled) */
  function disableNonEditableCFCells() {
    ensureCustomFields(function (cfields) {
      cfields.forEach(function (cf) {
        if (cf.field_format === 'attachment') {
          document.querySelectorAll('td.cf_' + cf.id).forEach(disableCFCell);
          return;
        }
        var trackerIds = cf.tracker_ids || [];
        if (trackerIds.length === 0) return;
        document.querySelectorAll('td.cf_' + cf.id).forEach(function (cell) {
          var tr = cell.closest('tr');
          if (!tr) return;
          var tId = trackerIdFromRow(tr);
          if (tId !== null && trackerIds.indexOf(tId) < 0) disableCFCell(cell);
        });
      });
    });
  }

  /* Watch for Redmine re-rendering the table via AJAX (filters, pagination) */
  function observeTableMutations(table) {
    if (!window.MutationObserver) return;
    var obs = new MutationObserver(function (mutations) {
      var decorated = false;
      mutations.forEach(function (m) {
        m.addedNodes.forEach(function (node) {
          if (node.nodeType === 1) {
            if (node.matches && node.matches('tr.issue, tr[id^="issue-"]')) {
              decorateRow(node);
              decorated = true;
            } else if (node.querySelectorAll) {
              node.querySelectorAll('tr.issue, tr[id^="issue-"]').forEach(decorateRow);
              decorated = true;
            }
          }
        });
      });
      if (decorated) disableNonEditableCFCells();
    });
    obs.observe(table.querySelector('tbody') || table, { childList: true, subtree: true });
  }

  /* ────────────────────────────────────────────────────────────
     BOOTSTRAP
     ──────────────────────────────────────────────────────────── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

}(window, document));
