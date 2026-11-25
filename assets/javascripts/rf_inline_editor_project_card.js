/**
 * RF Inline Editor — Project Card Module
 *
 * action-index : inline editing of project name + custom fields on the board/card view.
 * action-show  : inline editing of custom fields on the project detail page.
 */
(function (window, document) {
  'use strict';

  var RfIE = window.RfIE;
  if (!RfIE) { console.error('RfIE core not loaded'); return; }
  if (!document.body.classList.contains('controller-projects')) return;
  if (!RfIE.config.canEditProjects) return;

  var BASE    = RfIE.config.baseUrl;
  var isIndex = document.body.classList.contains('action-index');
  var isShow  = document.body.classList.contains('action-show');

  /* ────────────────────────────────────────────────────────────
     SHARED — custom field definitions
     ──────────────────────────────────────────────────────────── */
  var _allCFs = null;
  var _cfDefs = {};

  function ensureAllCFs(cb) {
    if (_allCFs) { cb(_allCFs); return; }
    RfIE.api.get(BASE + '/all_custom_fields')
      .then(function (d) { _allCFs = Array.isArray(d) ? d : []; cb(_allCFs); })
      .catch(function () { _allCFs = []; cb([]); });
  }

  function getCFDef(cfId, cb) {
    if (_cfDefs[cfId] !== undefined) { cb(_cfDefs[cfId]); return; }
    ensureAllCFs(function (cfs) {
      var found = null;
      for (var i = 0; i < cfs.length; i++) {
        if (parseInt(cfs[i].id, 10) === cfId) { found = cfs[i]; break; }
      }
      _cfDefs[cfId] = found;
      cb(found);
    });
  }

  /* Any OTHER required Project custom field (CustomField#is_required —
     Projects have no status-driven workflow like Issues, so this is the
     only "required" concept that applies) currently blank on this project.
     Excludes excludeCfId (the field this very save is setting) since that
     field's own validity is what the save itself is for. Mirrors
     rf_inline_editor_project_table.js's missingRequiredProjectFields — same
     check, needed here too since this module (card/board view + project
     show page) saves through its own separate PUT calls rather than a
     shared saveProject function. Without this, saving one field while some
     OTHER required custom field is blank would fail with a generic
     Redmine validation error naming a field the user never touched, instead
     of being sent to the full Edit form where every required field is shown
     together. */
  function missingRequiredProjectFields(ident, excludeCfId, cb) {
    RfIE.api.get(BASE + '/projects/' + ident + '/rf_project?include=custom_fields')
      .then(function (data) {
        var proj = data.project;
        ensureAllCFs(function (cfs) {
          var missing = cfs.filter(function (cf) {
            if (cf.customized_type !== 'Project' || !cf.is_required) return false;
            if (excludeCfId != null && String(cf.id) === String(excludeCfId)) return false;
            var found = null;
            if (proj && proj.custom_fields) {
              for (var i = 0; i < proj.custom_fields.length; i++) {
                if (proj.custom_fields[i].id === cf.id) { found = proj.custom_fields[i]; break; }
              }
            }
            var v = found ? found.value : null;
            return Array.isArray(v) ? v.filter(Boolean).length === 0 : (v === null || v === undefined || v === '');
          });
          cb(missing);
        });
      })
      .catch(function () { cb([]); } /* couldn't fetch — don't block the save on our own failure */);
  }

  function extractMsg(err) {
    if (!err) return RfIE.i18n('genericSaveError');
    if (typeof err === 'string') return err;
    if (err.errors && Array.isArray(err.errors)) return err.errors.join(', ');
    if (err.message) {
      if (err.message === 'HTTP 403') return RfIE.i18n('noPermissionProject');
      if (err.message === 'HTTP 404') return RfIE.i18n('projectNotFound');
      if (err.message === 'HTTP 422') return RfIE.i18n('valueNotSavedProject');
      if (err.message === 'HTTP 500') return RfIE.i18n('serverError');
    }
    return RfIE.i18n('genericSaveError');
  }

  /* ════════════════════════════════════════════════════════════
     action-index — PROJECT CARDS (BOARD VIEW)
     ════════════════════════════════════════════════════════════ */
  if (isIndex) {

    var _numIds   = {};   /* identifier → numeric project id */
    var _cardMem  = {};   /* identifier → [{id, name}] */
    var _cardVer  = {};   /* identifier → [{id, name}] */
    var _activeCancel = null;

    /* ── Bootstrap ─────────────────────────────────────────── */
    function initCards() {
      var index = document.querySelector('#projects-index');
      if (!index) return;
      ensureAllCFs(function () {
        decorateAll(index);
        /* Watch for subprojects toggled into view */
        new MutationObserver(function (muts) {
          muts.forEach(function (mut) {
            mut.addedNodes.forEach(function (n) {
              if (n.nodeType !== 1) return;
              if (n.matches && (n.matches('li.root') || n.matches('li.child'))) {
                decorateOneCard(n);
              } else if (n.querySelectorAll) {
                n.querySelectorAll('li.root, li.child').forEach(decorateOneCard);
              }
            });
          });
        }).observe(index, { childList: true, subtree: true });
      });
    }

    function decorateAll(root) {
      root.querySelectorAll('li.root, li.child').forEach(decorateOneCard);
    }

    function decorateOneCard(li) {
      if (li.dataset.rfCardIdx) return;
      li.dataset.rfCardIdx = '1';

      var inner = li.querySelector(':scope > div.root, :scope > div.child');
      if (!inner) return;

      var projLink = inner.querySelector('a.project');
      if (!projLink) return;

      var href = projLink.getAttribute('href') || '';
      var urlM = href.match(/\/projects\/([^\/?\#]+)/);
      if (!urlM) return;
      var ident = urlM[1];
      /* Redmine identifiers are letters, digits, - and _; anything else is not a project address. */
      if (!/^[A-Za-z0-9_-]+$/.test(ident)) return;

      var numId = resolveNumIdFromDOM(li);
      if (numId) _numIds[ident] = numId;

      decorateName(inner, projLink, ident);

      var details = inner.querySelector('.custom-details');
      if (!details) return;
      details.querySelectorAll(':scope > div').forEach(function (div) {
        if (div.classList.contains('project-members') || div.classList.contains('issues-info')) return;
        var cfId = parseInt(div.getAttribute('id'), 10);
        if (!cfId) return;
        decorateCF(div, cfId, ident);
      });
    }

    function resolveNumIdFromDOM(li) {
      var ti = li.querySelector(':scope > div > span.toggle-icon[data-project-id]');
      if (ti && ti.dataset.projectId) return parseInt(ti.dataset.projectId, 10);
      var ml = li.querySelector('div.project-members a[href]');
      if (ml) {
        var m = (ml.getAttribute('href') || '').match(/\/projects\/(\d+)$/);
        if (m) return parseInt(m[1], 10);
      }
      return null;
    }

    function getNumId(ident, cb) {
      if (_numIds[ident]) { cb(_numIds[ident]); return; }
      RfIE.api.get(BASE + '/projects/' + ident + '/rf_project')
        .then(function (d) {
          var id = d && d.project && d.project.id;
          if (id) _numIds[ident] = id;
          cb(id || null);
        })
        .catch(function () { cb(null); });
    }

    /* ── Project name ─────────────────────────────────────── */
    function decorateName(inner, projLink, ident) {
      if (inner.dataset.rfNameDec) return;
      inner.dataset.rfNameDec = '1';
      inner.classList.add('rf-card-name-host');

      /* Append icon INSIDE <a> so it sits in the block's inline flow —
         avoids the flexbox/display:block specificity battle with projects_card.css
         that caused the icon to render on a separate line below the text. */
      var icon = RfIE.dom.editIcon();
      icon.className += ' rf-card-name-icon';
      projLink.appendChild(icon);

      icon.addEventListener('click', function (e) {
        e.stopPropagation(); e.preventDefault();
        startNameEdit(inner, projLink, ident);
      });
    }

    function startNameEdit(inner, projLink, ident) {
      if (_activeCancel) { _activeCancel(); }

      /* Read from first text node only — projLink.textContent would
         include the appended icon SVG content */
      var currentName = projLink.firstChild && projLink.firstChild.nodeType === 3
        ? projLink.firstChild.textContent.trim()
        : projLink.textContent.trim();

      inner.classList.add('rf-card-editing');
      projLink.style.display = 'none';

      var inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'rf-input rf-card-name-input';
      inp.value = currentName;
      inner.insertBefore(inp, projLink);
      inp.focus();
      inp.select();

      function cancel() {
        inp.remove();
        projLink.style.display = '';
        inner.classList.remove('rf-card-editing');
        disposeOut(); disposeEsc();
        _activeCancel = null;
      }

      function save() {
        var val = inp.value.trim();
        if (!val || val === currentName) { cancel(); return; }
        inp.disabled = true; inp.style.opacity = '0.5';

        missingRequiredProjectFields(ident, null, function (missing) {
          if (missing.length) {
            /* Some other required custom field is blank — resubmit this
               same name change as a real form POST to Redmine's own update
               action so its native validation-failure page (every required
               field shown together) takes over, instead of a generic error
               naming a field the user never touched. */
            RfIE.submitEditFormWithFullCf(
              BASE + '/projects/' + ident,
              BASE + '/projects/' + ident + '/rf_project?include=custom_fields',
              'project',
              { 'project[name]': val }
            );
            return;
          }
          doSaveName();
        });

        function doSaveName() {
          RfIE.api.put(BASE + '/projects/' + ident + '/rf_project', { project: { name: val } })
            .then(function (d) {
              var newName = (d && d.project && d.project.name) || val;
              /* Update only the first text node — do NOT overwrite the icon */
              if (projLink.firstChild && projLink.firstChild.nodeType === 3) {
                projLink.firstChild.textContent = newName;
              }
              inp.remove();
              projLink.style.display = '';
              inner.classList.remove('rf-card-editing');
              disposeOut(); disposeEsc();
              _activeCancel = null;
              RfIE.toast.success(RfIE.i18n('projectNameUpdated'));
            })
            .catch(function (err) {
              inp.remove();
              projLink.style.display = '';
              inner.classList.remove('rf-card-editing');
              disposeOut(); disposeEsc();
              _activeCancel = null;
              RfIE.toast.error(extractMsg(err));
            });
        }
      }

      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter')  { e.preventDefault(); save(); }
        if (e.key === 'Escape') { cancel(); }
      });

      var disposeOut = RfIE.onClickOutside(inp, cancel);
      var disposeEsc = RfIE.onEscape(cancel);
      _activeCancel = cancel;
    }

    /* ── Custom fields ────────────────────────────────────── */
    function decorateCF(cfDiv, cfId, ident) {
      if (cfDiv.dataset.rfCfDec) return;
      cfDiv.dataset.rfCfDec = '1';

      /* Capture display text before touching the DOM */
      var displayText = cfDiv.textContent.trim();

      /* Wrap the CF div's content in a flex row so pencil sits inline at the right */
      var inner = document.createElement('span');
      inner.className = 'rf-card-cf-inner';

      var textSpan = document.createElement('span');
      textSpan.className = 'rf-card-cf-text';
      textSpan.textContent = displayText;

      var icon = RfIE.dom.editIcon();
      icon.className += ' rf-card-cf-icon';

      inner.appendChild(textSpan);
      inner.appendChild(icon);

      cfDiv.innerHTML = '';
      cfDiv.appendChild(inner);
      cfDiv.classList.add('rf-card-cf-item');

      /* CSS :hover on cfDiv shows the pencil icon — no JS hover needed */
      icon.addEventListener('click', function (e) {
        e.stopPropagation();
        startCFEdit(cfDiv, cfId, ident, textSpan, displayText);
      });
    }

    function startCFEdit(cfDiv, cfId, ident, textSpan, fallbackText) {
      if (_activeCancel) { _activeCancel(); }
      if (cfDiv.classList.contains('rf-card-editing')) return;

      cfDiv.classList.add('rf-card-editing');
      var currentText = textSpan.textContent.trim() || fallbackText;
      textSpan.style.display = 'none';

      /* Show spinner while fetching CF definition */
      var cfInner = cfDiv.querySelector('.rf-card-cf-inner');
      var spinner = document.createElement('span');
      spinner.className = 'rf-spinner';
      if (cfInner) cfInner.appendChild(spinner);

      getCFDef(cfId, function (cf) {
        spinner.remove();
        if (!cf) {
          textSpan.style.display = '';
          cfDiv.classList.remove('rf-card-editing');
          return;
        }

        /* Editor container inserted before the pencil icon */
        var edWrap = document.createElement('span');
        edWrap.className = 'rf-card-cf-editor';
        if (cfInner) cfInner.insertBefore(edWrap, cfInner.querySelector('.rf-card-cf-icon'));

        function cancel() {
          edWrap.remove();
          textSpan.style.display = '';
          cfDiv.classList.remove('rf-card-editing');
          disposeOut(); disposeEsc();
          _activeCancel = null;
        }

        function save(value) {
          disposeOut(); disposeEsc();
          _activeCancel = null;
          edWrap.innerHTML = '<span class="rf-spinner"></span>';

          missingRequiredProjectFields(ident, cfId, function (missing) {
            if (missing.length) {
              var fields = {};
              fields['project[custom_field_values][' + cfId + ']'] = value;
              RfIE.submitEditFormWithFullCf(
                BASE + '/projects/' + ident,
                BASE + '/projects/' + ident + '/rf_project?include=custom_fields',
                'project',
                fields
              );
              return;
            }
            doSaveCF();
          });

          function doSaveCF() {
            var cfPayload = {};
            cfPayload[String(cfId)] = value;

            RfIE.api.put(BASE + '/projects/' + ident + '/rf_project', {
              project: { custom_field_values: cfPayload }
            }).then(function () {
              /* Read the project again: Redmine drops a value the user may not set without saying so, so what is
                 shown must be what is stored, not what was typed. */
              return RfIE.api.get(BASE + '/projects/' + ident + '/rf_project');
            }).then(function (fresh) {
              edWrap.remove();
              var stored = null;
              ((fresh && fresh.project && fresh.project.custom_fields) || []).forEach(function (c) {
                if (parseInt(c.id, 10) === cfId) stored = c;
              });
              if (!stored) {
                textSpan.style.display = '';
                cfDiv.classList.remove('rf-card-editing');
                RfIE.toast.error(RfIE.i18n('valueNotSavedProject'));
                return;
              }
              /* Resolve the display label BEFORE busting the caches — for user/version
                 formats resolveDisplayVal looks up _cardMem/_cardVer, which would be
                 empty if we deleted them first (showing raw IDs instead of names). */
              var dv = resolveDisplayVal(cf, stored.value, ident);
              delete _cardMem[ident];
              delete _cardVer[ident];
              textSpan.textContent = dv;
              textSpan.style.display = '';
              cfDiv.classList.remove('rf-card-editing');
              RfIE.toast.success(RfIE.i18n('savedSuccessfully'));
            }).catch(function (err) {
              edWrap.remove();
              textSpan.style.display = '';
              cfDiv.classList.remove('rf-card-editing');
              RfIE.toast.error(extractMsg(err));
            });
          }
        }

        buildCFEditor(cf, currentText, ident, edWrap, save, cancel);

        var disposeOut = RfIE.onClickOutside(cfDiv, cancel);
        var disposeEsc = RfIE.onEscape(cancel);
        _activeCancel = cancel;

        var first = edWrap.querySelector('input, select, textarea');
        if (first) first.focus();
      });
    }

    /* ── CF editor builder ─────────────────────────────── */
    function buildCFEditor(cf, curText, ident, wrap, onSave, onCancel) {
      var fmt   = cf.field_format;
      var multi = cf.multiple;
      var vals  = cf.possible_values || [];

      if (fmt === 'bool') {
        /* Blank option only offered for a dropdown/radio display style
           (edit_tag_style '' / 'radio') on an optional field — a checkbox
           style (Redmine's single_check_box_edit_tag) is a plain Yes/No
           toggle with no third state regardless of is_required, and a
           required field must never offer a blank choice either. */
        var boolAllowBlank = cf.edit_tag_style !== 'check_box' && !cf.is_required;
        wrap.appendChild(cfSelect(
          [{ id: '1', name: 'Yes' }, { id: '0', name: 'No' }],
          curText, boolAllowBlank, onSave
        ));

      } else if (fmt === 'list') {
        var listOpts = vals.map(function (v) { return { id: v, name: v }; });
        if (multi) {
          wrap.appendChild(cfMultiSelect(listOpts, curText ? curText.split(/,\s*/) : [], onSave));
        } else {
          wrap.appendChild(cfSelect(listOpts, curText, true, onSave));
        }

      } else if (fmt === 'enumeration') {
        var enumOpts = vals.map(function (v) {
          return typeof v === 'object' ? { id: v.id, name: v.label || v.name } : { id: v, name: String(v) };
        });
        wrap.appendChild(cfSelect(enumOpts, curText, true, onSave));

      } else if (fmt === 'user') {
        fetchMembers(ident, function (members) {
          var ss = cfSearchable(members, curText, true, onSave);
          wrap.appendChild(ss);
          if (ss.focusInput) ss.focusInput(); else { var i = wrap.querySelector('input'); if (i) i.focus(); }
        });

      } else if (fmt === 'version') {
        fetchVersions(ident, function (versions) {
          var ss = cfSearchable(versions, curText, true, onSave);
          wrap.appendChild(ss);
          if (ss.focusInput) ss.focusInput(); else { var i = wrap.querySelector('input'); if (i) i.focus(); }
        });

      } else if (fmt === 'date') {
        var iso = RfIE.dateUtils ? RfIE.dateUtils.toISO(curText) : curText;
        wrap.appendChild(cfDate(iso, onSave));

      } else if (fmt === 'float') {
        wrap.appendChild(cfNumber(curText, 0.01, onSave));

      } else if (fmt === 'int') {
        wrap.appendChild(cfNumber(curText, 1, onSave));

      } else if (fmt === 'text') {
        wrap.appendChild(cfTextarea(curText, onSave));

      } else {
        /* string / link */
        wrap.appendChild(cfText(curText, onSave));
      }
    }

    /* ── Display value resolution ──────────────────────── */
    function resolveDisplayVal(cf, rawValue, ident) {
      if (rawValue === null || rawValue === undefined || rawValue === '') return '';
      if (Array.isArray(rawValue)) return rawValue.join(', ');
      var fmt = cf.field_format;
      if (fmt === 'bool') return rawValue === '1' ? 'Yes' : 'No';
      if (fmt === 'user') {
        var m = _cardMem[ident] || [];
        for (var i = 0; i < m.length; i++) {
          if (String(m[i].id) === String(rawValue)) return m[i].name;
        }
      }
      if (fmt === 'version') {
        var v = _cardVer[ident] || [];
        for (var j = 0; j < v.length; j++) {
          if (String(v[j].id) === String(rawValue)) return v[j].name;
        }
      }
      if (fmt === 'enumeration') {
        var vals = cf.possible_values || [];
        for (var k = 0; k < vals.length; k++) {
          var opt = vals[k];
          if (typeof opt === 'object' && String(opt.id) === String(rawValue)) return opt.label || opt.name;
          if (typeof opt === 'string' && opt === String(rawValue)) return opt;
        }
      }
      if (fmt === 'float') { var n = parseFloat(rawValue); return isNaN(n) ? rawValue : n.toFixed(2); }
      return String(rawValue);
    }

    /* ── Data fetchers ──────────────────────────────────── */
    function fetchMembers(ident, cb) {
      if (_cardMem[ident]) { cb(_cardMem[ident]); return; }
      getNumId(ident, function (numId) {
        if (!numId) { cb([]); return; }
        RfIE.api.get(BASE + '/projects/' + numId + '/active_members')
          .then(function (d) {
            _cardMem[ident] = (d.active_members || []).map(function (m) { return { id: m.id, name: m.name }; });
            cb(_cardMem[ident]);
          })
          .catch(function () { _cardMem[ident] = []; cb([]); });
      });
    }

    function fetchVersions(ident, cb) {
      if (_cardVer[ident]) { cb(_cardVer[ident]); return; }
      getNumId(ident, function (numId) {
        if (!numId) { cb([]); return; }
        RfIE.api.get(BASE + '/' + numId + '/all_versions?indata=yes')
          .then(function (d) {
            _cardVer[ident] = (d.version || []).map(function (v) { return { id: v.id, name: v.name }; });
            cb(_cardVer[ident]);
          })
          .catch(function () { _cardVer[ident] = []; cb([]); });
      });
    }

    /* ── Input factory helpers ──────────────────────────── */
    function cfText(val, onChange) {
      var inp = document.createElement('input');
      inp.type = 'text'; inp.className = 'rf-input rf-card-inp'; inp.value = val || '';
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); onChange(inp.value.trim()); }
      });
      return inp;
    }

    function cfNumber(val, step, onChange) {
      var inp = document.createElement('input');
      inp.type = 'number'; inp.className = 'rf-input rf-card-inp';
      inp.value = val || ''; inp.step = step || 1;
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); onChange(inp.value); }
      });
      return inp;
    }

    function cfDate(iso, onChange) {
      var inp = document.createElement('input');
      inp.type = 'date'; inp.className = 'rf-input rf-card-inp'; inp.value = iso || '';
      /* Always fire onChange, including when cleared (inp.value === '') —
         see the matching comment in rf_inline_editor_project_table.js's
         buildDate. Redmine's own full validation on the native project
         update decides whether blank is acceptable for this field. */
      RfIE.bindDateInput(inp, onChange);
      return inp;
    }

    function cfTextarea(val, onChange) {
      var ta = document.createElement('textarea');
      ta.className = 'rf-textarea rf-card-ta'; ta.value = val || ''; ta.rows = 2;
      ta.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onChange(ta.value.trim()); }
      });
      return ta;
    }

    function cfSelect(options, selectedName, allowBlank, onChange) {
      var sel = document.createElement('select');
      sel.className = 'rf-select rf-card-sel';
      if (allowBlank) {
        var bl = document.createElement('option'); bl.value = ''; bl.textContent = RfIE.i18n('none'); sel.appendChild(bl);
      }
      var norm = (selectedName || '').trim().toLowerCase();
      options.forEach(function (opt) {
        var o = document.createElement('option');
        o.value = String(opt.id); o.textContent = opt.name;
        if (opt.name.trim().toLowerCase() === norm) o.selected = true;
        sel.appendChild(o);
      });
      /* Always fire onChange, including for the blank option
         (value === '') — that option only exists when allowBlank is true,
         so guarding it out here silently prevented ever clearing such a
         field: selecting None just left the previous value in place. */
      sel.addEventListener('change', function () { onChange(sel.value); });
      return sel;
    }

    function cfMultiSelect(options, currentVals, onChange) {
      var sel = document.createElement('select');
      sel.className = 'rf-select rf-card-sel'; sel.multiple = true;
      sel.size = Math.min(options.length, 4);
      options.forEach(function (opt) {
        var o = document.createElement('option');
        o.value = String(opt.id); o.textContent = opt.name;
        if (currentVals.indexOf(opt.name) >= 0 || currentVals.indexOf(String(opt.id)) >= 0) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          onChange(Array.from(sel.selectedOptions).map(function (o) { return o.value; }));
        }
      });
      return sel;
    }

    function cfSearchable(options, selectedName, allowBlank, onChange) {
      var selOpt = options.filter(function (o) {
        return o.name.trim().toLowerCase() === (selectedName || '').trim().toLowerCase();
      })[0];
      return new RfIE.SearchableSelect(options, {
        selectedId:  selOpt ? selOpt.id : null,
        allowBlank:  allowBlank,
        minWidth:    '160px',
        onSelect:    function (id) { onChange(id); }
      });
    }

    /* Boot */
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initCards);
    } else {
      initCards();
    }

  } /* end isIndex */

  /* ════════════════════════════════════════════════════════════
     action-show — PROJECT DETAIL PAGE
     ════════════════════════════════════════════════════════════ */
  if (isShow) {

    var _showProjId   = null;
    var _showMembers  = null;
    var _showVersions = null;
    var _activeDisp   = null;

    function initShow() {
      var urlMatch = window.location.pathname.match(/\/projects\/([^\/]+)/);
      if (!urlMatch || !/^[A-Za-z0-9_-]+$/.test(urlMatch[1])) return;
      RfIE.api.get(BASE + '/projects/' + urlMatch[1] + '/rf_project')
        .then(function (d) { _showProjId = d.project && d.project.id; decorateShow(); })
        .catch(function () {
          var el = document.querySelector('[data-project-id]');
          if (el) { _showProjId = parseInt(el.dataset.projectId, 10); decorateShow(); }
        });
    }

    function decorateShow() {
      document.querySelectorAll(
        'div.custom-details > div:not(.issues-info):not(.project-members), ' +
        '.cf_value, [class*="cf_"] .value'
      ).forEach(function (container) {
        if (container.dataset.rfShowDec) return;
        container.dataset.rfShowDec = '1';
        var cfId = extractCfId(container);
        if (!cfId) return;
        var wrap = document.createElement('span'); wrap.className = 'rf-card-field';
        var disp = document.createElement('span'); disp.className = 'rf-cf-display'; disp.innerHTML = container.innerHTML;
        var icon = RfIE.dom.editIcon();
        wrap.appendChild(disp); wrap.appendChild(icon);
        container.innerHTML = ''; container.appendChild(wrap);
        container.addEventListener('mouseenter', function () { icon.style.opacity = '0.7'; });
        container.addEventListener('mouseleave', function () { icon.style.opacity = '0'; });
        icon.addEventListener('click', function (e) { e.stopPropagation(); startShowEdit(container, cfId, disp); });
      });
      document.querySelectorAll('.attributes .attribute').forEach(function (attr) {
        if (attr.dataset.rfShowDec) return;
        var cfCls = Array.from(attr.classList).find(function (c) { return /^cf_\d+$/.test(c); });
        if (!cfCls) return;
        attr.dataset.rfShowDec = '1';
        var cfId = parseInt(cfCls.replace('cf_', ''), 10);
        var valueEl = attr.querySelector('.value'); if (!valueEl) return;
        var disp = document.createElement('span'); disp.className = 'rf-cf-display'; disp.innerHTML = valueEl.innerHTML;
        var icon = RfIE.dom.editIcon();
        var wrap = document.createElement('span'); wrap.className = 'rf-card-field';
        wrap.appendChild(disp); wrap.appendChild(icon); valueEl.innerHTML = ''; valueEl.appendChild(wrap);
        attr.addEventListener('mouseenter', function () { icon.style.opacity = '0.7'; });
        attr.addEventListener('mouseleave', function () { icon.style.opacity = '0'; });
        icon.addEventListener('click', function (e) { e.stopPropagation(); startShowEdit(valueEl, cfId, disp); });
      });
    }

    function extractCfId(el) {
      var s = el;
      while (s && s !== document.body) {
        var m = s.className && s.className.match(/\bcf_(\d+)\b/);
        if (m) return parseInt(m[1], 10);
        s = s.parentElement;
      }
      return null;
    }

    function startShowEdit(container, cfId, disp) {
      if (_activeDisp) { _activeDisp(); _activeDisp = null; }
      getCFDef(cfId, function (cf) {
        if (!cf) return;
        buildShowEditor(cf, disp.textContent.trim(), container, disp, function (value) {
          saveShowCF(cfId, value, disp);
        });
      });
    }

    function buildShowEditor(cf, curText, container, disp, onSave) {
      var fmt = cf.field_format, multi = cf.multiple, vals = cf.possible_values || [];
      var edWrap = document.createElement('span'); edWrap.className = 'rf-card-editor-wrap';
      var dOut, dEsc;
      function cleanup() {
        edWrap.remove(); disp.style.display = '';
        if (dOut) { dOut(); dOut = null; } if (dEsc) { dEsc(); dEsc = null; }
        _activeDisp = null;
      }
      _activeDisp = cleanup;
      disp.style.display = 'none';
      function commit(v) { cleanup(); onSave(v); }

      if (fmt === 'bool') {
        /* Blank option only for a dropdown/radio display style on an optional
           field — see the matching comment at the card-view bool branch
           above; a checkbox style or a required field must never offer it. */
        var boolShowAllowBlank = cf.edit_tag_style !== 'check_box' && !cf.is_required;
        var bs = showSel([{id:'1',name:'Yes'},{id:'0',name:'No'}], curText==='Yes'?'Yes':'No', function(id){commit(id);}, boolShowAllowBlank);
        edWrap.appendChild(bs); disp.insertAdjacentElement('afterend', edWrap); bs.focus();
      } else if (fmt === 'list') {
        var lo = vals.map(function(v){return{id:v,name:v};});
        if (multi) {
          var cv = curText ? curText.split(/,\s*/) : [];
          var ms = showMultiSel(lo, cv, function(vs){commit(vs.join(','));});
          edWrap.appendChild(ms); disp.insertAdjacentElement('afterend', edWrap); ms.focus();
        } else {
          var ss2 = showSel(lo, curText, function(id){commit(id);}, true);
          edWrap.appendChild(ss2); disp.insertAdjacentElement('afterend', edWrap); ss2.focus();
        }
      } else if (fmt === 'user') {
        showFetchMem(function(m) {
          var sw = showSearch(m, curText, true, function(id){commit(id);});
          edWrap.appendChild(sw); disp.insertAdjacentElement('afterend', edWrap);
          if (sw.focusInput) sw.focusInput();
        });
      } else if (fmt === 'version') {
        showFetchVer(function(v) {
          var sw = showSearch(v, curText, true, function(id){commit(id);});
          edWrap.appendChild(sw); disp.insertAdjacentElement('afterend', edWrap);
          if (sw.focusInput) sw.focusInput();
        });
      } else if (fmt === 'date') {
        var iso = RfIE.dateUtils ? RfIE.dateUtils.toISO(curText) : curText;
        var di = showDate(iso, function(v){commit(v);}); edWrap.appendChild(di); disp.insertAdjacentElement('afterend', edWrap); di.focus();
      } else if (fmt === 'text') {
        var ta = showTa(curText, function(v){commit(v);}); edWrap.appendChild(ta); disp.insertAdjacentElement('afterend', edWrap);
        var te = ta.tagName==='TEXTAREA'?ta:ta.querySelector('textarea'); if(te)te.focus();
      } else if (fmt === 'int' || fmt === 'float') {
        var ni = showNum(curText, fmt==='float'?0.01:1, function(v){commit(v);}); edWrap.appendChild(ni); disp.insertAdjacentElement('afterend', edWrap); ni.focus();
      } else {
        var ti = showTxt(curText, function(v){commit(v);}); edWrap.appendChild(ti); disp.insertAdjacentElement('afterend', edWrap); ti.focus();
      }
      dOut = RfIE.onClickOutside(edWrap, cleanup);
      dEsc = RfIE.onEscape(cleanup);
    }

    function saveShowCF(cfId, value, disp) {
      if (!_showProjId) { RfIE.toast.error(RfIE.i18n('projectIdNotFound')); return; }

      missingRequiredProjectFields(_showProjId, cfId, function (missing) {
        if (missing.length) {
          var fields = {};
          fields['project[custom_field_values][' + cfId + ']'] = value;
          RfIE.submitEditFormWithFullCf(
            BASE + '/projects/' + _showProjId,
            BASE + '/projects/' + _showProjId + '/rf_project?include=custom_fields',
            'project',
            fields
          );
          return;
        }
        doSaveShowCF();
      });

      function doSaveShowCF() {
        var cfPayload = {}; cfPayload[String(cfId)] = value;
        RfIE.api.put(BASE + '/projects/' + _showProjId + '/rf_project', { project: { custom_field_values: cfPayload } })
          .then(function () {
            disp.textContent = Array.isArray(value) ? value.join(', ') : (value || '—');
            disp.style.display = '';
            RfIE.toast.success(RfIE.i18n('savedSuccessfully'));
          })
          .catch(function (err) { disp.style.display = ''; RfIE.toast.error(extractMsg(err)); });
      }
    }

    function showFetchMem(cb) {
      if (_showMembers) { cb(_showMembers); return; }
      if (!_showProjId) { cb([]); return; }
      RfIE.api.get(BASE + '/projects/' + _showProjId + '/active_members')
        .then(function(d){ _showMembers=(d.active_members||[]).map(function(m){return{id:m.id,name:m.name};}); cb(_showMembers); })
        .catch(function(){ _showMembers=[]; cb([]); });
    }
    function showFetchVer(cb) {
      if (_showVersions) { cb(_showVersions); return; }
      if (!_showProjId) { cb([]); return; }
      RfIE.api.get(BASE+'/'+_showProjId+'/all_versions?indata=yes')
        .then(function(d){ _showVersions=(d.version||[]).map(function(v){return{id:v.id,name:v.name};}); cb(_showVersions); })
        .catch(function(){ _showVersions=[]; cb([]); });
    }
    function showTxt(val,onChange){var i=document.createElement('input');i.type='text';i.className='rf-input';i.value=val||'';i.style.minWidth='120px';i.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();onChange(i.value.trim());}});return i;}
    function showTa(val,onChange){var w=document.createElement('span');w.style.display='inline-block';var t=document.createElement('textarea');t.className='rf-textarea';t.value=val||'';t.rows=3;t.style.minWidth='200px';t.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();onChange(t.value.trim());}});w.appendChild(t);return w;}
    function showDate(iso,onChange){var i=document.createElement('input');i.type='date';i.className='rf-input';i.value=iso||'';RfIE.bindDateInput(i,onChange);return i;}
    function showNum(val,step,onChange){var i=document.createElement('input');i.type='number';i.className='rf-input';i.value=val||'';i.step=step||1;i.style.width='80px';i.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();onChange(i.value);}});return i;}
    function showSel(options,sel,onChange,allowBlank){var s=document.createElement('select');s.className='rf-select';if(allowBlank){var b=document.createElement('option');b.value='';b.textContent=RfIE.i18n('none');s.appendChild(b);}options.forEach(function(opt){var o=document.createElement('option');o.value=opt.id;o.textContent=opt.name;if(opt.name===sel)o.selected=true;s.appendChild(o);});s.addEventListener('change',function(){onChange(s.value);});return s;}
    function showMultiSel(options,curVals,onChange){var w=document.createElement('span');w.style.display='inline-block';var s=document.createElement('select');s.className='rf-select';s.multiple=true;s.size=Math.min(options.length,5);options.forEach(function(opt){var o=document.createElement('option');o.value=opt.id;o.textContent=opt.name;if(curVals.indexOf(opt.name)>=0||curVals.indexOf(String(opt.id))>=0)o.selected=true;s.appendChild(o);});s.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();onChange(Array.from(s.selectedOptions).map(function(o){return o.value;}));}});w.appendChild(s);return w;}
    function showSearch(options,selName,allowBlank,onChange){var so=options.filter(function(o){return o.name===selName;})[0];return new RfIE.SearchableSelect(options,{selectedId:so?so.id:null,allowBlank:allowBlank,minWidth:'140px',onSelect:function(id){onChange(id);}});}

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initShow);
    } else {
      initShow();
    }

  } /* end isShow */

}(window, document));
