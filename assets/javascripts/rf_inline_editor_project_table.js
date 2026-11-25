/**
 * RF Inline Editor — Project List Table Module
 * Handles click-to-edit for every editable cell in the project index table.
 *
 * Editable : name, homepage, is_public, parent, default_version, custom fields
 * Skipped  : identifier, description (per product spec), status (separate archive action),
 *            id, checkbox, created_on, updated_on, activities, members, subprojects
 */
(function (window, document) {
  'use strict';

  var RfIE = window.RfIE;
  if (!RfIE) { console.error('RfIE core not loaded'); return; }

  if (!document.body.classList.contains('controller-projects') ||
      !document.body.classList.contains('action-index')) return;

  if (!RfIE.config.canEditProjects) return;

  var BASE = RfIE.config.baseUrl;

  var _cfCache       = null;
  var _projCache     = null;
  var _projDataCache = {};  /* projId → full project JSON (for pre-selecting current values) */
  var _memberCache   = {};
  var _versionCache  = {};

  /* Columns that must never show a pencil */
  var SKIP = [
    'id', 'checkbox', 'created_on', 'updated_on', 'status',
    'activities', 'members', 'subprojects',
    'identifier', 'description', 'short_description', 'tags',
    'last_activity_date', 'total_spent_time', 'total_estimated_time',
    'divergent_hours', 'approved_hours', 'total_remaining_hours',
    'enumeration', 'attachment', 'attachments'
  ];

  /* ── HTML escaping ───────────────────────────────────────── */
  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ────────────────────────────────────────────────────────────
     INIT
     ──────────────────────────────────────────────────────────── */
  function init() {
    var table = document.querySelector('table.list.projects');
    if (!table) return;
    prefetchCustomFields();
    decorateTable(table);
    disableNonEditableCFCells();
    observeTable(table);
  }

  function decorateTable(table) {
    table.querySelectorAll('tbody tr.project, tbody tr[id^="project-"]').forEach(decorateRow);
  }

  function decorateRow(tr) {
    if (tr.dataset.rfDecorated) return;
    tr.dataset.rfDecorated = '1';

    tr.querySelectorAll('td').forEach(function (td) {
      var cls = firstClass(td);
      if (!cls || SKIP.indexOf(cls) >= 0) return;

      /* Wrap existing content in flex layout */
      var existing = td.innerHTML.trim();
      var wrapper  = document.createElement('span');
      wrapper.className = 'rf-cell-wrapper';
      var display = document.createElement('span');
      display.className = 'rf-cell-display';
      display.innerHTML = existing;
      var icon = RfIE.dom.editIcon();
      wrapper.appendChild(display);
      wrapper.appendChild(icon);
      td.innerHTML = '';
      td.appendChild(wrapper);

      td.addEventListener('mouseenter', function () {
        if (td.classList.contains('rf-no-edit')) return;
        var el = td.querySelector('.rf-edit-icon');
        if (el && !td.classList.contains('rf-editing')) el.style.opacity = '0.7';
      });
      td.addEventListener('mouseleave', function () {
        var el = td.querySelector('.rf-edit-icon');
        if (el) el.style.opacity = '0';
      });
      /* Event delegation — survives innerHTML rebuilds inside td */
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
     EDIT LIFECYCLE
     ──────────────────────────────────────────────────────────── */
  var _activeCancel = null;

  function startEdit(td, tr) {
    if (_activeCancel) { _activeCancel(); _activeCancel = null; }

    var projId = projectIdFromRow(tr);
    if (!projId) return;

    /* Lock width to prevent layout shift */
    var computedW = td.getBoundingClientRect().width;
    td.style.minWidth = computedW + 'px';
    td.style.width    = computedW + 'px';

    /* Snapshot current content (with icon hidden so it doesn't leak into snapshot) */
    var wrapper = td.querySelector('.rf-cell-wrapper');
    var snapIcon = wrapper ? wrapper.querySelector('.rf-edit-icon') : null;
    if (snapIcon) snapIcon.style.opacity = '0';
    var originalHTML = wrapper ? wrapper.innerHTML : td.innerHTML;

    td.classList.add('rf-editing');

    function cancelEdit() {
      td.classList.remove('rf-editing');
      td.style.minWidth = '';
      td.style.width    = '';
      if (wrapper) {
        wrapper.innerHTML = originalHTML;
        if (!wrapper.parentElement) { td.innerHTML = ''; td.appendChild(wrapper); }
      } else {
        td.innerHTML = originalHTML;
      }
      var iconEl = td.querySelector('.rf-edit-icon');
      if (iconEl) iconEl.style.opacity = '0';
      _activeCancel = null;
    }

    _activeCancel = cancelEdit;
    buildProjectEditor(td, tr, firstClass(td), projId, cancelEdit);
  }

  /* ────────────────────────────────────────────────────────────
     EDITOR BUILDER
     ──────────────────────────────────────────────────────────── */
  function buildProjectEditor(td, tr, cls, projId, cancelFn) {
    var wrapper = td.querySelector('.rf-cell-wrapper');

    /* Capture display text BEFORE the wrapper is swapped out.
       After td.replaceChild(loaderWrap, wrapper) the .rf-cell-display span is
       detached from the DOM, so currentText(td) returns '' — pre-selection
       breaks for every field.  Read it first, exactly like the issue table does. */
    var curText = currentText(td);

    /* Replace wrapper with a loading spinner while fetching data */
    var loaderWrap = document.createElement('div');
    loaderWrap.className = 'rf-cell-editor-wrap';
    loaderWrap.innerHTML = '<span class="rf-spinner"></span>';
    if (wrapper) td.replaceChild(loaderWrap, wrapper);
    else { td.innerHTML = ''; td.appendChild(loaderWrap); }

    /* Click-outside and Escape cancel immediately — even during data fetch */
    var disposeOutside = RfIE.onClickOutside(td, function () {
      dispose();
      if (td.classList.contains('rf-editing')) cancelFn();
    });
    var disposeEsc = RfIE.onEscape(function () {
      dispose();
      if (td.classList.contains('rf-editing')) cancelFn();
    });

    function dispose() { disposeOutside(); disposeEsc(); _activeCancel = null; }
    _activeCancel = function () { dispose(); cancelFn(); };

    function renderEditor(el) {
      if (!td.classList.contains('rf-editing')) return;
      loaderWrap.innerHTML = '';
      loaderWrap.appendChild(el);
    }

    /* ── Name ──────────────────────────────────────────────── */
    if (cls === 'name') {
      var nameInp = buildText(curText, function (val) {
        saveProject(td, tr, projId, { 'project[name]': val }, cancelFn, function (d) {
          if (!d || !d.project) return null;
          var slug = d.project.identifier || projId;
          return '<a href="' + BASE + '/projects/' + esc(String(slug)) + '">' +
                 esc(d.project.name || val) + '</a>';
        });
      });
      renderEditor(nameInp);
      nameInp.querySelector('input') && nameInp.querySelector('input').focus();
      return;
    }

    /* ── Homepage ──────────────────────────────────────────── */
    if (cls === 'homepage') {
      var hmInp = buildText(curText, function (val) {
        saveProject(td, tr, projId, { 'project[homepage]': val }, cancelFn, function (d) {
          if (!d || !d.project) return null;
          var hp = d.project.homepage || '';
          return hp ? RfIE.linkHtml(hp, esc) : '—';
        });
      });
      renderEditor(hmInp);
      hmInp.querySelector('input') && hmInp.querySelector('input').focus();
      return;
    }

    /* ── Is public ─────────────────────────────────────────── */
    if (cls === 'public' || cls === 'is_public') {
      /* Redmine may render this column as a checkmark icon rather than text,
         so reading curText is unreliable. Fetch project data for the true value. */
      fetchProjectData(projId, function (proj) {
        var isPublic = !!(proj && proj.is_public);
        var pubSel = buildSelect(
          [{ id: '1', name: 'Yes' }, { id: '0', name: 'No' }],
          isPublic ? 'Yes' : 'No',
          function (id) {
            saveProject(td, tr, projId, { 'project[is_public]': id }, cancelFn, function (d) {
              if (!d || !d.project) return null;
              /* Bust the cached project data so the next open reflects new value */
              delete _projDataCache[projId];
              return d.project.is_public ? 'Yes' : 'No';
            });
          },
          false
        );
        renderEditor(pubSel);
      }, cancelFn);
      return;
    }

    /* ── Default version ───────────────────────────────────── */
    if (cls === 'default_version') {
      fetchProjectVersions(projId, function (versions) {
        var dvSel = buildSearchable(versions, curText, true, function (id) {
          saveProject(td, tr, projId, { 'project[default_version_id]': id }, cancelFn, function (d) {
            if (!d || !d.project) return null;
            var dv = d.project.default_version;
            return dv
              ? '<a href="' + BASE + '/versions/' + esc(String(dv.id)) + '">' + esc(dv.name) + '</a>'
              : '—';
          });
        });
        renderEditor(dvSel);
        dvSel.focusInput();
      });
      return;
    }

    /* ── Parent project ────────────────────────────────────── */
    if (cls === 'parent_id' || cls === 'parent') {
      fetchAllProjects(function (projects) {
        var opts = projects.filter(function (p) { return String(p.id) !== String(projId); });
        var parSel = buildSearchable(opts, curText, true, function (id) {
          saveProject(td, tr, projId, { 'project[parent_id]': id }, cancelFn, function (d) {
            if (!d || !d.project) return null;
            var par = d.project.parent;
            return par
              ? '<a href="' + BASE + '/projects/' + esc(String(par.id)) + '">' + esc(par.name) + '</a>'
              : '—';
          });
        });
        renderEditor(parSel);
        parSel.focusInput();
      });
      return;
    }

    /* ── Custom fields ─────────────────────────────────────── */
    var cfMatch = td.className.match(/\bcf_(\d+)\b/);
    if (cfMatch) {
      buildCFEditor(td, tr, parseInt(cfMatch[1], 10), projId, renderEditor, cancelFn, curText);
      return;
    }

    /* Fallback — nothing matched, restore */
    loaderWrap.remove();
    if (wrapper) td.appendChild(wrapper);
  }

  /* ────────────────────────────────────────────────────────────
     CUSTOM FIELD EDITOR
     ──────────────────────────────────────────────────────────── */
  function buildCFEditor(td, tr, cfId, projId, renderEditor, cancelFn, curText) {
    ensureCF(function (cfields) {
      var cf = null;
      for (var i = 0; i < cfields.length; i++) {
        if (parseInt(cfields[i].id, 10) === cfId &&
            cfields[i].customized_type === 'Project') { cf = cfields[i]; break; }
      }
      if (!cf) { cancelFn(); return; }

      var fmt    = cf.field_format;
      var multi  = cf.multiple;
      var vals   = cf.possible_values || [];
      var apiKey = 'project[custom_field_values][' + cfId + ']';
      /* curText is passed in from buildProjectEditor, captured BEFORE the
         cell's wrapper was swapped for the loading spinner — re-reading it
         here via currentText(td) (as this used to do) always returned ''
         instead, since by the time this async ensureCF callback runs the
         cell's .rf-cell-display span is long gone. That silently broke
         pre-selection for every custom field editor on this page (date,
         text, int/float, link, …), not just one format. */

      /* Resolve an array of raw enumeration ids to their display labels —
         used by both optimisticDisplay and formatDisplay below so a
         multi-value Key/Value field shows names, not raw ids, right after
         saving (not just after a page refresh). */
      function enumIdsToLabels(ids) {
        return ids.map(function (id) {
          for (var i = 0; i < vals.length; i++) {
            var ev = vals[i];
            var evId = typeof ev === 'object' ? String(ev.id) : String(ev);
            if (String(id) === evId) {
              return typeof ev === 'object' ? (ev.label || ev.name || evId) : String(ev);
            }
          }
          return String(id);
        });
      }

      /* Show optimistic value when PUT response doesn't include this CF */
      function optimisticDisplay(value) {
        if (value === null || value === undefined || value === '') return '—';
        if (fmt === 'float') {
          var f = parseFloat(value);
          return isNaN(f) ? esc(String(value)) : esc(f.toFixed(2));
        }
        if (fmt === 'bool') return (value === '1' || value === 1) ? 'Yes' : 'No';
        if (fmt === 'enumeration' && !Array.isArray(value)) {
          for (var ei = 0; ei < vals.length; ei++) {
            var ev = vals[ei];
            var evId = typeof ev === 'object' ? String(ev.id) : String(ev);
            if (String(value) === evId) {
              return esc(typeof ev === 'object' ? (ev.label || ev.name || evId) : String(ev));
            }
          }
        }
        if (Array.isArray(value)) {
          var names = fmt === 'enumeration' ? enumIdsToLabels(value) : value;
          return esc(names.join(', ')) || '—';
        }
        return esc(String(value));
      }

      /* Extract raw CF value from a project GET/PUT response */
      function cfFromResponse(data) {
        var cfs = data && data.project && data.project.custom_fields;
        if (!cfs) return null;
        for (var j = 0; j < cfs.length; j++) {
          if (parseInt(cfs[j].id, 10) === cfId) return cfs[j].value;
        }
        return null;
      }

      /* Convert raw CF value to display HTML */
      function formatDisplay(v) {
        if (v === null || v === undefined || v === '') return '—';
        if (Array.isArray(v)) {
          var names = fmt === 'enumeration' ? enumIdsToLabels(v) : v;
          return esc(names.join(', ')) || '—';
        }
        if (fmt === 'float') {
          var fv = parseFloat(v);
          return isNaN(fv) ? esc(String(v)) : esc(fv.toFixed(2));
        }
        if (fmt === 'link' && v) {
          return RfIE.linkHtml(v, esc);
        }
        return esc(String(v));
      }

      function saveCF(value) {
        var payload = {};
        payload[apiKey] = value;
        saveProject(td, tr, projId, payload, cancelFn, function (data) {
          var v = cfFromResponse(data);
          /* null = this answer does not say what is stored: the cell is then filled from a fresh read of the
             project (see saveProject), never from what was typed. */
          return v !== null ? formatDisplay(v) : null;
        });
      }

      function saveCFMulti(values) {
        var payload = {};
        if (values.length === 0) {
          /* Clearing to zero selections must still send SOMETHING for this
             field — an empty payload silently drops the clear entirely, and
             if the required-field check falls back to a full form resubmit
             with that same empty payload, Rails' params.require(:project)
             raises a raw "param is missing" error. See the matching fix in
             rf_inline_editor_issue_table.js's saveAndUpdate. */
          payload['project[custom_field_values][' + cfId + '][]'] = '';
        } else {
          values.forEach(function (v, i) {
            payload['project[custom_field_values][' + cfId + '][' + i + ']'] = v;
          });
        }
        saveProject(td, tr, projId, payload, cancelFn, function (data) {
          var v = cfFromResponse(data);
          if (v !== null) return formatDisplay(v);
          if (!values.length) return '—';
          /* Enumeration ("Key/Value list") values ARE numeric ids, unlike
             plain "list" CFs where the value doubles as its own display
             name — resolve to labels here too so the fallback path matches
             formatDisplay's own handling. */
          var fallbackNames = fmt === 'enumeration' ? enumIdsToLabels(values) : values;
          return esc(fallbackNames.join(', '));
        });
      }

      /* ── Attachment — not editable inline ── */
      if (fmt === 'attachment') { cancelFn(); return; }

      /* ── Enumeration ── */
      if (fmt === 'enumeration') {
        var enumOpts = vals.map(function (v) {
          return typeof v === 'object'
            ? { id: v.id, name: v.label || v.name }
            : { id: v, name: String(v) };
        });
        /* Fetch actual stored value to pre-select by ID — more reliable than
           matching cell display text against option names */
        fetchProjectData(projId, function (proj) {
          var rawVal = cfRawFromProject(proj, cfId);
          if (multi) {
            /* "Multiple values" enabled — rawVal may be an array; fall back
               to the cell's comma-joined display text if the API gave
               nothing. Previously this fell straight into the single-select
               branch below regardless of cf.multiple, so only one value
               could ever be picked even though the field was configured to
               allow several.
               A bare native <select multiple> renders as a cramped, easy-
               to-miss listbox — RfIE.MultiSelect (chip + searchable-
               checkbox widget) is the same control already used for this
               exact shape on the issue list page, for a consistent look
               across every multi-value field. */
            var curVals = Array.isArray(rawVal) ? rawVal
                          : (rawVal ? [String(rawVal)] : (curText ? curText.split(/,\s*/) : []));
            var enumMs = new RfIE.MultiSelect(enumOpts, {
              selectedIds: curVals,
              minWidth: '160px'
            });
            renderEditor(buildMultiSelectEditorWrap(enumMs, function () { saveCFMulti(enumMs.getValues()); }, cancelFn));
            enumMs.focusInput();
            return;
          }
          /* Find which option has the current raw value as its id */
          var preselect = '';
          if (rawVal !== null && rawVal !== undefined) {
            for (var ei = 0; ei < enumOpts.length; ei++) {
              if (String(enumOpts[ei].id) === String(rawVal)) {
                preselect = enumOpts[ei].name;
                break;
              }
            }
          }
          /* Fall back to cell text if API gave nothing */
          if (!preselect) preselect = curText;
          /* the blank option only ever offered when the field is optional — this
             was previously hardcoded to true regardless of cf.is_required,
             so a required Key/Value field still showed a None option that
             should never have been selectable. */
          renderEditor(buildSelect(enumOpts, preselect, function (id) { saveCF(id); }, !cf.is_required));
        }, cancelFn);
        return;
      }

      /* ── Bool ── */
      if (fmt === 'bool') {
        /* Bool CFs may render as icons rather than "Yes"/"No" text;
           fetch project data to get the actual stored value reliably. */
        fetchProjectData(projId, function (proj) {
          var raw = cfRawFromProject(proj, cfId);
          /* raw is '1'/'0'/true/false/null/'' from the API */
          var isNoneVal = raw === null || raw === undefined || raw === '';
          var isTrueVal = raw === '1' || raw === 1 || raw === true ||
                          (typeof raw === 'string' && raw.toLowerCase() === 'yes');
          var selectedName;
          if (isNoneVal) {
            /* No API value at all (fetch failed) — fall back to the cell
               text instead of treating it as a genuine None. */
            selectedName = (raw === undefined) ? (isBoolTrue(curText) ? 'Yes' : 'No') : '';
          } else {
            selectedName = isTrueVal ? 'Yes' : 'No';
          }
          /* A blank-option choice should only ever be offered when this
             Boolean CF is displayed as a dropdown/radio group (edit_tag_style
             is '' / 'radio', not 'check_box') AND the field is optional —
             mirrors the already-fixed pattern in
             rf_inline_editor_issue_table.js. Redmine's own
             single_check_box_edit_tag (checkbox display style) is a single
             Yes/No toggle with no third state to represent blank, regardless
             of is_required, and a required dropdown/radio field must never
             offer a blank choice either. Without this, every boolean CF here
             always got a None option (even required ones) and clearing it
             silently did nothing (buildSelect's change handler used to
             swallow blank selections — fixed above). */
          var allowBlank = cf.edit_tag_style !== 'check_box' && !cf.is_required;
          renderEditor(buildSelect(
            [{ id: '1', name: 'Yes' }, { id: '0', name: 'No' }],
            selectedName,
            function (id) { saveCF(id); },
            allowBlank
          ));
        }, cancelFn);
        return;
      }

      /* ── List ── */
      if (fmt === 'list') {
        var listOpts = vals.map(function (v) { return { id: v, name: v }; });
        fetchProjectData(projId, function (proj) {
          var rawVal = cfRawFromProject(proj, cfId);
          if (multi) {
            /* rawVal may be an array for multi-select — same RfIE.MultiSelect
               widget as the enumeration branch above, for a consistent look
               across every multi-value field on this page rather than a
               bare native <select multiple>. */
            var curVals = Array.isArray(rawVal) ? rawVal
                          : (rawVal ? [String(rawVal)] : (curText ? curText.split(/,\s*/) : []));
            var listMs = new RfIE.MultiSelect(listOpts, {
              selectedIds: curVals,
              minWidth: '160px'
            });
            renderEditor(buildMultiSelectEditorWrap(listMs, function () { saveCFMulti(listMs.getValues()); }, cancelFn));
            listMs.focusInput();
          } else {
            var preselect = (rawVal !== null && rawVal !== undefined) ? String(rawVal) : curText;
            /* the blank option only when the field is optional — this was
               previously hardcoded to true regardless of cf.is_required,
               so a required List field still showed a None option that
               should never have been selectable (mirrors the same fix
               already applied to enumeration/boolean above). */
            renderEditor(buildSelect(listOpts, preselect, function (id) { saveCF(id); }, !cf.is_required));
          }
        }, cancelFn);
        return;
      }

      /* ── User ── */
      if (fmt === 'user') {
        fetchProjectMembers(projId, function (members) {
          function memberHtml(userId) {
            if (!userId) return '—';
            for (var mi = 0; mi < members.length; mi++) {
              if (String(members[mi].id) === String(userId)) {
                return '<a href="' + BASE + '/users/' + esc(String(userId)) + '">' +
                       esc(members[mi].name) + '</a>';
              }
            }
            return esc(String(userId));
          }
          /* "Multiple values" enabled — this previously always fell into
             the single-select buildSearchable below regardless of
             cf.multiple, so only one user could ever be assigned even
             though the field was configured to allow several (mirrors the
             enumeration/list multi-select fix above). */
          if (multi) {
            fetchProjectData(projId, function (proj) {
              var rawVal = cfRawFromProject(proj, cfId);
              var curVals = Array.isArray(rawVal) ? rawVal.map(String)
                            : (rawVal ? [String(rawVal)] : []);
              /* Same RfIE.MultiSelect chip/checkbox widget the enumeration/
                 list branches use above, for a consistent look across every
                 multi-value field rather than a bare native <select
                 multiple>. */
              var userMs = new RfIE.MultiSelect(members, {
                selectedIds: curVals,
                minWidth: '160px'
              });
              renderEditor(buildMultiSelectEditorWrap(userMs, function () {
                var ids = userMs.getValues();
                var payload = {};
                if (ids.length === 0) {
                  payload[apiKey + '[]'] = '';
                } else {
                  ids.forEach(function (id, i) { payload[apiKey + '[' + i + ']'] = id; });
                }
                saveProject(td, tr, projId, payload, cancelFn, function (data) {
                  var v = cfFromResponse(data);
                  var finalIds = Array.isArray(v) ? v : ids;
                  return finalIds.length ? finalIds.map(memberHtml).join(', ') : '—';
                });
              }, cancelFn));
              userMs.focusInput();
            }, cancelFn);
            return;
          }
          var ss = buildSearchable(members, curText, true, function (id) {
            var payload = {};
            payload[apiKey] = id;
            saveProject(td, tr, projId, payload, cancelFn, function (data) {
              var v = cfFromResponse(data);
              return v !== null ? memberHtml(v) : memberHtml(id);
            });
          });
          renderEditor(ss);
          ss.focusInput();
        });
        return;
      }

      /* ── Version ── */
      if (fmt === 'version') {
        fetchProjectVersions(projId, function (versions) {
          function versionHtml(vId) {
            if (!vId) return '—';
            for (var vi = 0; vi < versions.length; vi++) {
              if (String(versions[vi].id) === String(vId)) {
                return '<a href="' + BASE + '/versions/' + esc(String(vId)) + '">' +
                       esc(versions[vi].name) + '</a>';
              }
            }
            return esc(String(vId));
          }
          /* Same multi-select gap as 'user' above. */
          if (multi) {
            fetchProjectData(projId, function (proj) {
              var rawVal = cfRawFromProject(proj, cfId);
              var curVals = Array.isArray(rawVal) ? rawVal.map(String)
                            : (rawVal ? [String(rawVal)] : []);
              /* Same RfIE.MultiSelect widget as 'user' above. */
              var versionMs = new RfIE.MultiSelect(versions, {
                selectedIds: curVals,
                minWidth: '160px'
              });
              renderEditor(buildMultiSelectEditorWrap(versionMs, function () {
                var ids = versionMs.getValues();
                var payload = {};
                if (ids.length === 0) {
                  payload[apiKey + '[]'] = '';
                } else {
                  ids.forEach(function (id, i) { payload[apiKey + '[' + i + ']'] = id; });
                }
                saveProject(td, tr, projId, payload, cancelFn, function (data) {
                  var v = cfFromResponse(data);
                  var finalIds = Array.isArray(v) ? v : ids;
                  return finalIds.length ? finalIds.map(versionHtml).join(', ') : '—';
                });
              }, cancelFn));
              versionMs.focusInput();
            }, cancelFn);
            return;
          }
          var ss = buildSearchable(versions, curText, true, function (id) {
            var payload = {};
            payload[apiKey] = id;
            saveProject(td, tr, projId, payload, cancelFn, function (data) {
              var v = cfFromResponse(data);
              return v !== null ? versionHtml(v) : versionHtml(id);
            });
          });
          renderEditor(ss);
          ss.focusInput();
        });
        return;
      }

      /* ── Progressbar ── */
      if (fmt === 'progressbar') {
        /* vals (cf.possible_values) is populated server-side (see
           IssueTablesController#all_custom_fields) as the real 0..100 step
           list generated from this CF's configured "Ratio interval"
           (cf.ratio_interval) — mirroring core's own edit_tag and the same
           fix already applied to rf_inline_editor_issue_table.js. Using a
           hardcoded 10% step here ignored that setting entirely, so a CF
           configured for e.g. a 5% interval still only ever showed
           0/10/20/…/100 in this dropdown. */
        var pbOpts = vals.map(function (v) {
          return typeof v === 'object' ? { id: v.id, name: v.label } : { id: v, name: v + ' %' };
        });
        if (!pbOpts.length) {
          for (var pi = 0; pi <= 100; pi += 10) pbOpts.push({ id: pi, name: pi + ' %' });
        }
        var pbRaw = parseInt(curText, 10) || 0;
        var pbClosest = pbOpts[0];
        var pbClosestDiff = Math.abs(pbRaw - (parseInt(pbClosest.id, 10) || 0));
        for (var pj = 1; pj < pbOpts.length; pj++) {
          var pbDiff = Math.abs(pbRaw - (parseInt(pbOpts[pj].id, 10) || 0));
          if (pbDiff < pbClosestDiff) { pbClosestDiff = pbDiff; pbClosest = pbOpts[pj]; }
        }
        renderEditor(buildSelect(pbOpts, pbClosest.name, function (val) { saveCF(val); }));
        return;
      }

      /* ── Date ── */
      if (fmt === 'date') {
        var dInp = buildDate(RfIE.dateUtils.toISO(curText), function (val) {
          var datePayload = {};
          datePayload[apiKey] = val;
          saveProject(td, tr, projId, datePayload, cancelFn, function (data) {
            var v = cfFromResponse(data);
            return v ? RfIE.dateUtils.toDisplay(v) : val ? RfIE.dateUtils.toDisplay(val) : '—';
          });
        });
        renderEditor(dInp);
        dInp.querySelector('input') && dInp.querySelector('input').focus();
        return;
      }

      /* ── Textarea (text) ── */
      if (fmt === 'text') {
        var ta = buildTextarea(curText, function (val) { saveCF(val); });
        renderEditor(ta);
        ta.querySelector('textarea') && ta.querySelector('textarea').focus();
        return;
      }

      /* ── Number (int / float) ── */
      if (fmt === 'int' || fmt === 'float') {
        var numInp = buildNumber(curText, fmt === 'float' ? 0.01 : 1, function (val) { saveCF(val); });
        renderEditor(numInp);
        numInp.querySelector('input') && numInp.querySelector('input').focus();
        return;
      }

      /* ── String / link (default) ── */
      var txtInp = buildText(curText, function (val) { saveCF(val); });
      renderEditor(txtInp);
      txtInp.querySelector('input') && txtInp.querySelector('input').focus();
    });
  }

  /* Any OTHER required Project custom field (per CustomField#is_required —
     Projects have no status-driven workflow like Issues, so this is the only
     "required" concept that applies) whose value is currently blank. Excludes
     excludeCfId (the field this very save is setting) since that field's own
     validity is what the save itself is for. Used to decide whether an
     inline edit should even be attempted (see saveProject below) — Redmine's
     native PUT /projects/:id.json runs full validation, so saving one field
     while an unrelated required custom field is blank would otherwise fail
     with a generic "X can't be blank" error toast that gives the user no way
     to actually fix it from this single-field editor. */
  function missingRequiredProjectFields(projId, excludeCfId, cb) {
    fetchProjectData(projId, function (proj) {
      ensureCF(function (cfields) {
        var missing = cfields.filter(function (cf) {
          if (cf.customized_type !== 'Project' || !cf.is_required) return false;
          if (excludeCfId != null && cf.id === excludeCfId) return false;
          var v = cfRawFromProject(proj, cf.id);
          return Array.isArray(v) ? v.filter(Boolean).length === 0 : (v === null || v === undefined || v === '');
        });
        cb(missing);
      });
    }, function () { cb([]); } /* couldn't fetch — don't block the save on our own failure */);
  }

  /* ────────────────────────────────────────────────────────────
     SAVE
     ──────────────────────────────────────────────────────────── */
  function saveProject(td, tr, projId, payload, cancelFn, getDisplayHtml) {
    var editedCfId = null;
    Object.keys(payload).forEach(function (k) {
      var m = k.match(/^project\[custom_field_values\]\[(\d+)\]/);
      if (m) editedCfId = parseInt(m[1], 10);
    });

    td.classList.add('rf-saving');

    /* Swap editor for saving indicator */
    var editorWrap = td.querySelector('.rf-cell-editor-wrap');
    if (editorWrap) {
      editorWrap.innerHTML =
        '<span class="rf-spinner"></span>' +
        '<span class="rf-saving-text">' + RfIE.i18n('saving') + '</span>';
    }

    missingRequiredProjectFields(projId, editedCfId, function (missing) {
      if (missing.length) {
        /* Some other required custom field is blank — resubmit this same
           single-field change through Redmine's own update action (a real
           form POST, not fetch/XHR) so ProjectsController#update's native
           validation-failure path runs and re-renders the Settings form with
           @project.errors populated — Redmine's own "N errors prohibited
           this project from being saved" box, not a custom toast. */
        RfIE.submitEditFormWithFullCf(BASE + '/projects/' + projId, BASE + '/projects/' + projId + '/rf_project?include=custom_fields', 'project', payload);
        return;
      }
      doSaveProjectRequest();
    });

    function doSaveProjectRequest() {
    RfIE.api.put(BASE + '/projects/' + projId + '/rf_project', buildProjectBody(payload))
      .then(function (data) {
        td.classList.remove('rf-saving');
        _activeCancel = null;
        /* Bust cached project data so next edit opens with fresh values */
        delete _projDataCache[projId];

        var html = null;
        try { html = getDisplayHtml(data); } catch (e) {}

        if (html === null) {
          /* PUT response didn't include the updated field — read the project again and show what is stored.
             Redmine drops a value the user may not set without saying so; if the field is not in the fresh
             read, the value was not saved - say so and put the old cell back instead of showing the typed text. */
          RfIE.api.get(BASE + '/projects/' + projId + '/rf_project')
            .then(function (d) {
              var fresh = null;
              try { fresh = getDisplayHtml(d); } catch (e) {}
              if (fresh === null) {
                RfIE.toast.error(RfIE.i18n('valueNotSavedProject'));
                if (cancelFn) cancelFn();
                return;
              }
              RfIE.toast.success(RfIE.i18n('changesSavedSuccessfully'));
              setCell(td, fresh);
            })
            .catch(function () { if (cancelFn) cancelFn(); });
        } else {
          RfIE.toast.success(RfIE.i18n('changesSavedSuccessfully'));
          setCell(td, html);
        }
      })
      .catch(function (err) {
        td.classList.remove('rf-saving');
        RfIE.toast.error(extractMsg(err));
        if (cancelFn) cancelFn();
      });
    }
  }

  /* Rebuild cell with new display HTML */
  function setCell(td, html) {
    td.classList.remove('rf-editing');
    td.style.minWidth = '';
    td.style.width    = '';

    var wrapper = document.createElement('span');
    wrapper.className = 'rf-cell-wrapper';
    var display = document.createElement('span');
    display.className = 'rf-cell-display';
    /* innerHTML so link fields (<a>) render correctly */
    display.innerHTML = (html !== null && html !== undefined) ? html : '—';
    var icon = RfIE.dom.editIcon();
    wrapper.appendChild(display);
    wrapper.appendChild(icon);
    td.innerHTML = '';
    td.appendChild(wrapper);
    /* td's mouseenter/click handlers survive — no need to re-attach */
  }

  function buildProjectBody(payload) {
    var project = {};
    Object.keys(payload).forEach(function (k) {
      /* Last bracket group is "\d*" (zero-or-more), not "\d+", so it also
         matches an empty "[]" suffix (clearing a multi-value field to zero
         selections), not just numeric indices — see the matching comment
         in rf_inline_editor_issue_table.js's buildIssueBody. */
      var m = k.match(/^project\[(.+?)\](?:\[(.+?)\])?(?:\[(\d*)\])?$/);
      if (!m) return;
      if (m[1] === 'custom_field_values') {
        /* Redmine's custom_field_values= expects a Hash keyed by CF id string,
           NOT an Array — calling stringify_keys on an Array raises NoMethodError. */
        if (!project.custom_field_values) project.custom_field_values = {};
        var cfId  = m[2];
        var cfIdx = m[3];
        if (cfIdx != null) {
          /* Multi-value list: accumulate into an array under the same key */
          if (!Array.isArray(project.custom_field_values[cfId])) {
            project.custom_field_values[cfId] = [];
          }
          project.custom_field_values[cfId].push(payload[k]);
        } else {
          project.custom_field_values[cfId] = payload[k];
        }
      } else {
        project[m[1]] = payload[k];
      }
    });
    return { project: project };
  }

  /* ────────────────────────────────────────────────────────────
     NON-EDITABLE CF CELLS
     ──────────────────────────────────────────────────────────── */
  function disableNonEditableCFCells() {
    ensureCF(function (cfields) {
      cfields.forEach(function (cf) {
        if (cf.field_format !== 'attachment') return;
        document.querySelectorAll('td.cf_' + cf.id).forEach(function (cell) {
          cell.classList.add('rf-no-edit');
          var icon = cell.querySelector('.rf-edit-icon');
          if (icon) icon.style.display = 'none';
        });
      });
    });
  }

  /* ────────────────────────────────────────────────────────────
     DATA FETCHERS
     ──────────────────────────────────────────────────────────── */
  function prefetchCustomFields() {
    if (_cfCache !== null) return;
    RfIE.api.get(BASE + '/all_custom_fields')
      .then(function (d) { _cfCache = Array.isArray(d) ? d : []; })
      .catch(function ()  { _cfCache = []; });
  }

  function ensureCF(cb) {
    if (_cfCache !== null) { cb(_cfCache); return; }
    RfIE.api.get(BASE + '/all_custom_fields')
      .then(function (d) { _cfCache = Array.isArray(d) ? d : []; cb(_cfCache); })
      .catch(function ()  { _cfCache = []; cb([]); });
  }

  function fetchAllProjects(cb) {
    if (_projCache) return cb(_projCache);
    RfIE.api.get(BASE + '/all_projects')
      .then(function (d) {
        _projCache = (d.projects || []).map(function (p) { return { id: p.id, name: p.name }; });
        cb(_projCache);
      })
      .catch(function () { cb([]); });
  }

  function fetchProjectMembers(projId, cb) {
    if (_memberCache[projId]) return cb(_memberCache[projId]);
    RfIE.api.get(BASE + '/projects/' + projId + '/active_members')
      .then(function (d) {
        _memberCache[projId] = (d.active_members || []).map(function (m) { return { id: m.id, name: m.name }; });
        cb(_memberCache[projId]);
      })
      .catch(function () { cb([]); });
  }

  /* Fetch and cache full project JSON — used to read current field values
     for pre-selection rather than relying on potentially-icon cell text. */
  function fetchProjectData(projId, cb, onError) {
    if (_projDataCache[projId]) { cb(_projDataCache[projId]); return; }
    RfIE.api.get(BASE + '/projects/' + projId + '/rf_project?include=custom_fields')
      .then(function (d) {
        _projDataCache[projId] = d.project || null;
        cb(_projDataCache[projId]);
      })
      .catch(function () { if (onError) onError(); });
  }

  /* Extract a raw CF value from a project data object (from fetchProjectData) */
  function cfRawFromProject(proj, cfId) {
    if (!proj || !proj.custom_fields) return null;
    for (var i = 0; i < proj.custom_fields.length; i++) {
      if (parseInt(proj.custom_fields[i].id, 10) === cfId) return proj.custom_fields[i].value;
    }
    return null;
  }

  /* Robust truthy check for boolean fields rendered as icons or localised text */
  function isBoolTrue(text) {
    var t = (text || '').trim();
    return t === '1' || t === 'true' || t === 'True' ||
           t.toLowerCase() === 'yes' || t === '✓' || t === '✔';
  }

  function fetchProjectVersions(projId, cb) {
    if (_versionCache[projId]) return cb(_versionCache[projId]);
    RfIE.api.get(BASE + '/' + projId + '/all_versions?indata=yes')
      .then(function (d) {
        _versionCache[projId] = (d.version || []).map(function (v) { return { id: v.id, name: v.name }; });
        cb(_versionCache[projId]);
      })
      .catch(function () { cb([]); });
  }

  /* ────────────────────────────────────────────────────────────
     CONTROL BUILDERS
     ──────────────────────────────────────────────────────────── */
  function buildText(val, onChange) {
    var w = document.createElement('div');
    w.className = 'rf-cell-editor-wrap';
    var i = document.createElement('input');
    i.type = 'text'; i.className = 'rf-input'; i.value = val || '';
    i.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onChange(i.value.trim()); }
    });
    w.appendChild(i); return w;
  }

  function buildTextarea(val, onChange) {
    var w = document.createElement('div');
    w.className = 'rf-cell-editor-wrap';
    var ta = document.createElement('textarea');
    ta.className = 'rf-textarea'; ta.value = val || ''; ta.rows = 3;
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); onChange(ta.value.trim()); }
    });
    w.appendChild(ta); return w;
  }

  function buildDate(iso, onChange) {
    var w = document.createElement('div');
    w.className = 'rf-cell-editor-wrap';
    var i = document.createElement('input');
    i.type = 'date'; i.className = 'rf-input'; i.value = iso || '';
    /* Always fire onChange, including when the user clears the date
       (i.value becomes ''). Guarding it out here silently prevented ever
       clearing an optional date field, and — since the native
       PUT /projects/:id.json request always runs Redmine's full validation
       (unlike the issue endpoint) — also meant a required date field never
       even got the chance to be rejected with a proper "can't be blank"
       error; save just never happened. Redmine's own validation now decides
       whether an empty value is acceptable, same as every other field. */
    RfIE.bindDateInput(i, onChange);
    w.appendChild(i); return w;
  }

  function buildNumber(val, step, onChange) {
    var w = document.createElement('div');
    w.className = 'rf-cell-editor-wrap';
    var i = document.createElement('input');
    i.type = 'number'; i.className = 'rf-input'; i.value = val || ''; i.step = step || 1;
    i.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onChange(i.value); }
    });
    w.appendChild(i); return w;
  }

  function buildSelect(options, selectedName, onChange, allowBlank) {
    var w = document.createElement('div');
    w.className = 'rf-cell-editor-wrap';
    var sel = document.createElement('select');
    sel.className = 'rf-select';
    var isBlank = !selectedName || selectedName === '—' || selectedName === '';
    if (allowBlank) {
      var blank = document.createElement('option');
      blank.value = ''; blank.textContent = RfIE.i18n('none');
      if (isBlank) blank.selected = true;
      sel.appendChild(blank);
    }
    var normSel = (selectedName || '').trim().toLowerCase();
    options.forEach(function (opt) {
      var o = document.createElement('option');
      o.value = String(opt.id); o.textContent = opt.name;
      /* Case-insensitive + trimmed match so locale text and minor whitespace
         differences don't break pre-selection */
      if (opt.name.trim().toLowerCase() === normSel) o.selected = true;
      sel.appendChild(o);
    });
    /* Always fire onChange, including when the user selects the blank
       the blank option (value === ''). That option only exists when
       allowBlank is true (i.e. the field is legitimately clearable), so
       guarding it out here silently prevented ever clearing such a field
       via this control — selecting None just left the previous value in
       place with no save happening at all. */
    sel.addEventListener('change', function () { onChange(sel.value); });
    sel.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); onChange(sel.value); }
    });
    w.appendChild(sel); sel.focus(); return w;
  }

  /** Wrap an RfIE.MultiSelect (chip + searchable-checkbox widget) with an
   *  inline confirm/discard icon pair, for any "pick zero or more of N
   *  options" cell editor on this page (enumeration/list/user/version
   *  formats with Multiple values enabled). Selection happens via several
   *  chip/checkbox toggles rather than one native 'change' event, so
   *  there's no single moment to auto-save on — mirrors the same widget's
   *  confirm/discard affordance already used on the issue list and issue
   *  detail pages (buildMultiSelectEditorWrap in rf_inline_editor_issue_table.js,
   *  buildMultiSelectUI in rf_inline_editor_issue_show.js). */
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

  function buildSearchable(options, selectedName, allowBlank, onChange) {
    var w = document.createElement('div');
    w.className = 'rf-cell-editor-wrap';
    var isBlank = !selectedName || selectedName === '—' || selectedName === '';
    var selOpt  = isBlank ? null : options.filter(function (o) { return o.name === selectedName; })[0];
    var ss = new RfIE.SearchableSelect(options, {
      selectedId:  selOpt ? selOpt.id : null,
      allowBlank:  allowBlank,
      minWidth:    '140px',
      onSelect:    function (id) { onChange(id); }
    });
    w.appendChild(ss);
    /* Proxy SearchableSelect methods so callers can use w.focusInput() */
    w.focusInput = function () { ss.focusInput(); };
    w.getValue   = function () { return ss.getValue(); };
    return w;
  }

  /* ────────────────────────────────────────────────────────────
     HELPERS
     ──────────────────────────────────────────────────────────── */
  function firstClass(td) {
    var classes = td.className.split(/\s+/);
    for (var i = 0; i < classes.length; i++) {
      var c = classes[i];
      if (c && c !== 'odd' && c !== 'even' && c !== 'hascontextmenu') return c;
    }
    return null;
  }

  function currentText(td) {
    var d = td.querySelector('.rf-cell-display');
    if (!d) return td.textContent.trim();
    /* Clone and strip Redmine icon spans (e.g. "My projects" person icon) whose
       hidden label text would otherwise pollute the value via textContent. */
    var clone = d.cloneNode(true);
    clone.querySelectorAll('.icon-only, .icon-label').forEach(function (el) {
      if (el.parentNode) el.parentNode.removeChild(el);
    });
    return clone.textContent.trim();
  }

  function projectIdFromRow(tr) {
    var m = (tr.id || '').match(/project-(\d+)/);
    if (m) return parseInt(m[1], 10);
    if (tr.dataset.id) return parseInt(tr.dataset.id, 10);
    return null;
  }

  function extractMsg(err) {
    if (!err) return RfIE.i18n('unexpectedError');
    if (typeof err === 'string') return err;
    if (err.errors && Array.isArray(err.errors) && err.errors.length) return err.errors.join(' ');
    if (err.message) {
      var m = err.message;
      if (m === 'HTTP 403') return RfIE.i18n('noPermissionProject');
      if (m === 'HTTP 404') return RfIE.i18n('projectNotFound');
      if (m === 'HTTP 422') return RfIE.i18n('changeNotSaved');
      if (m === 'HTTP 500') return RfIE.i18n('serverError');
      if (m.indexOf('Failed to fetch') >= 0 || m.indexOf('NetworkError') >= 0) {
        return RfIE.i18n('connectionError');
      }
    }
    return RfIE.i18n('genericSaveError');
  }

  /* ────────────────────────────────────────────────────────────
     MUTATION OBSERVER
     ──────────────────────────────────────────────────────────── */
  function observeTable(table) {
    if (!window.MutationObserver) return;
    var obs = new MutationObserver(function (mutations) {
      var decorated = false;
      mutations.forEach(function (m) {
        m.addedNodes.forEach(function (n) {
          if (n.nodeType !== 1) return;
          if (n.matches && (n.matches('tr.project') || n.matches('tr[id^="project-"]'))) {
            decorateRow(n); decorated = true;
          } else if (n.querySelectorAll) {
            n.querySelectorAll('tr.project, tr[id^="project-"]').forEach(decorateRow);
            decorated = true;
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
