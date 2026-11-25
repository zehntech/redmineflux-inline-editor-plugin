/**
 * RF Inline Editor — Issue Show Page Module
 * Handles click-to-edit for all attribute fields, description, and subject
 * on the issue detail (show) page.
 *
 * Design principles:
 *  • Clones existing form elements from the hidden issue-form — no DOM duplication.
 *  • Edit panel opens inline below (or replacing) the current display value.
 *  • For simple controls (select): change event saves automatically.
 *  • For text inputs: Enter saves, Escape/click-outside cancels.
 *  • For description (rich text): save/cancel buttons are provided.
 *  • No popup overlays — everything in-place.
 *  • Full lock_version conflict detection.
 */
(function (window, document) {
  'use strict';

  var RfIE = window.RfIE;
  if (!RfIE) { console.error('RfIE core not loaded'); return; }

  /* Only operate on the issue show page */
  if (!document.body.classList.contains('controller-issues') ||
      !document.body.classList.contains('action-show')) return;

  /* Permission guard */
  /* issueEditable (set in _rf_header_assets.html.erb from core's own
     Issue#attributes_editable?) is the authoritative per-issue check —
     it's true either when the user has :edit_issues (can edit any issue)
     or when they only have :edit_own_issues AND authored this specific
     issue. Using the page-wide canEditIssues flag here was wrong: a user
     with only :edit_own_issues got canEditIssues = false and the inline
     editor never appeared at all, even on issues they authored. */
  if (!RfIE.config.issueEditable) return;

  var BASE = RfIE.config.baseUrl;

  /* Current page URL stripped to the issue path */
  function issueUrl() {
    var u = new URL(window.location.href);
    return u.origin + u.pathname.replace(/\/$/, '');
  }

  /* ────────────────────────────────────────────────────────────
     MAIN INIT
     ──────────────────────────────────────────────────────────── */
  function init() {
    var details = document.querySelector('div.issue.details');
    if (!details) return;

    /* Decorate all attribute fields */
    decorateAttributes(details);

    /* Decorate description */
    decorateDescription(details);

    /* Decorate subject */
    decorateSubject(details);

    /* Sprint (agile plugin) */
    decorateSprint(details);

    /* Story points (agile plugin) */
    decorateStoryPoints(details);

    /* Related issues "Add" form loading indicator */
    decorateRelations(details);
  }

  /* ────────────────────────────────────────────────────────────
     RELATED ISSUES
     ──────────────────────────────────────────────────────────── */
  /* Show a small spinner next to the "Add" button while a relate/unrelate
     request is in flight, so the 2-3s gap before the server response
     replaces #relations isn't silent. Bound on the #relations container
     (not on #new-relation-form directly) because that form's innerHTML is
     replaced wholesale by issue_relations/create.js.erb on every response —
     listening on the stable parent keeps this working after re-renders. */
  function decorateRelations(details) {
    var relations = details.querySelector('#relations');
    if (!relations) return;
    if (relations.dataset.rfRelDec) return;
    relations.dataset.rfRelDec = '1';

    relations.addEventListener('ajax:beforeSend', function (e) {
      var form = e.target;
      if (!form || form.id !== 'new-relation-form') return;
      showRelationSpinner(form);
    });

    relations.addEventListener('ajax:complete', function () {
      hideRelationSpinner();
    });
  }

  function showRelationSpinner(form) {
    hideRelationSpinner();
    var btn = form.querySelector('input[type="submit"]');
    if (!btn) return;
    var spin = RfIE.dom.spinner();
    spin.id = 'rf-relation-spinner';
    spin.style.marginLeft = '4px';
    btn.disabled = true;
    btn.parentNode.insertBefore(spin, btn.nextSibling);
  }

  function hideRelationSpinner() {
    var el = document.getElementById('rf-relation-spinner');
    if (el) el.remove();
    /* Normally #new-relation-form is replaced wholesale by the server
       response, so the disabled attribute is moot by this point. But if the
       request fails before a response arrives (network error, timeout), the
       old form node survives — re-enable its button so "Add" isn't stuck
       disabled. */
    var btn = document.querySelector('#new-relation-form input[type="submit"]');
    if (btn) btn.disabled = false;
  }

  /* ────────────────────────────────────────────────────────────
     ATTRIBUTE FIELDS
     ──────────────────────────────────────────────────────────── */
  function decorateAttributes(details) {
    details.querySelectorAll('.attributes .attribute').forEach(function (attr) {
      /* Guard: skip already-decorated attributes to prevent duplicate pencils
         when decorateAttributes is called multiple times (e.g. after each save). */
      if (attr.dataset.rfDecorated) return;
      attr.dataset.rfDecorated = '1';

      var classes   = Array.from(attr.classList);
      var fieldName = deriveFieldName(classes);
      if (!fieldName) return;

      /* Sprint and story-points have dedicated async decorators (decorateSprint /
         decorateStoryPoints) that fetch their option lists from the agile API.
         Skipping them here prevents a double pencil icon on initial page load —
         both paths used to run independently because they guard with different
         dataset flags (rfDecorated vs rfAgileDec). */
      if (fieldName === 'story_points' || fieldName === 'sprint') return;

      /* Find the matching form element in the hidden issue-form */
      var formEl = getFormElement(fieldName);
      if (!formEl) return;

      var valueEl = attr.querySelector('.value');
      if (!valueEl) return;

      /* Wrap existing display content so we can hide it when the editor opens,
         preventing both the value text and the editor from showing at once. */
      var displayWrap = document.createElement('span');
      displayWrap.className = 'rf-show-display';
      while (valueEl.firstChild) {
        displayWrap.appendChild(valueEl.firstChild);
      }
      valueEl.appendChild(displayWrap);

      /* Insert pencil icon */
      var icon = RfIE.dom.editIcon();
      valueEl.appendChild(icon);

      /* For non-CF fields: build panel eagerly (type is known immediately).
         For CF fields: build lazily on first click so _cfTypeMap is populated
         by the time the user interacts (avoids async race with API pre-fetch). */
      var editorPanel = null;
      var isCfField = fieldName.startsWith('custom_field_values_');

      if (!isCfField) {
        editorPanel = buildEditorPanel(formEl, fieldName, valueEl);
        valueEl.appendChild(editorPanel);
      }

      /* JS hover: only show pencil when not editing */
      attr.addEventListener('mouseenter', function () {
        if (valueEl.classList.contains('rf-value-editing')) return;
        var el = attr.querySelector('.rf-edit-icon');
        if (el) el.style.opacity = '0.7';
      });
      attr.addEventListener('mouseleave', function () {
        var el = attr.querySelector('.rf-edit-icon');
        if (el) el.style.opacity = '0';
      });

      /* Click pencil → open editor */
      icon.addEventListener('click', function (e) {
        e.stopPropagation();
        if (!editorPanel) {
          editorPanel = buildEditorPanel(formEl, fieldName, valueEl);
          valueEl.appendChild(editorPanel);
        }
        openEditor(editorPanel, valueEl, icon);
      });
    });
  }

  function deriveFieldName(classList) {
    var skip = ['attribute'];
    var name = null;
    classList.forEach(function (c) {
      if (skip.indexOf(c) < 0) {
        var mapped = c.replace(/-/g, '_');
        if (mapped === 'progress') mapped = 'done_ratio';
        if (mapped.startsWith('cf_')) mapped = mapped.replace('cf_', 'custom_field_values_');
        name = mapped;
      }
    });
    return name;
  }

  function getFormElement(fieldName) {
    /* Try several selector patterns that Redmine uses */
    var selectors = [
      '#issue_' + fieldName + '_id',
      '#issue_' + fieldName,
      '#' + fieldName
    ];
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el) return el;
    }
    /* Custom field checkbox group */
    if (fieldName.startsWith('custom_field_values_')) {
      var cfId = fieldName.split('custom_field_values_')[1];
      var cb = document.querySelector('#issue_custom_field_values_' + cfId);
      if (cb) {
        var group = cb.closest('.check_box_group');
        if (group) return group;
      }
      /* Radio/check group fallback */
      var radioGroup = document.querySelector('.cf_' + cfId + '.check_box_group');
      if (radioGroup) return radioGroup;
    }
    return null;
  }

  /* Fields that use a searchable dropdown instead of a native select */
  var SEARCHABLE_SHOW_FIELDS = {
    assigned_to:   'issue[assigned_to_id]',
    fixed_version: 'issue[fixed_version_id]'
  };

  /* CF id → field_format, pre-fetched on init so buildEditorPanel can check
     synchronously. _cfBoolOptionsMap additionally carries the localized
     Yes/No {id, label} pairs for bool CFs — bool has no options a client
     could otherwise discover (a "check_box" edit_tag_style bool field is
     just a bare checkbox with no adjacent label text), so this is the only
     way to give it the same searchable-dropdown treatment as list/
     enumeration/user/version without hardcoding English Yes/No strings
     that could mismatch the site's locale. */
  var _cfTypeMap = {};
  var _cfBoolOptionsMap = {};
  (function () {
    RfIE.api.get(BASE + '/all_custom_fields')
      .then(function (data) {
        if (Array.isArray(data)) {
          data.forEach(function (cf) {
            _cfTypeMap[String(cf.id)] = cf.field_format;
            if (cf.field_format === 'bool' && Array.isArray(cf.possible_values)) {
              _cfBoolOptionsMap[String(cf.id)] = cf.possible_values;
            }
          });
        }
      })
      .catch(function () {});
  })();

  function buildEditorPanel(formEl, fieldName, valueEl) {
    var panel = document.createElement('div');
    panel.className = 'rf-show-editor';
    panel.dataset.rfField = fieldName;

    if (SEARCHABLE_SHOW_FIELDS[fieldName]) {
      buildSearchableField(formEl, valueEl, panel, SEARCHABLE_SHOW_FIELDS[fieldName]);
      return panel;
    }

    /* Multi-select custom field — use the chip/checkbox MultiSelect instead
       of cloning Redmine's bare native <select multiple>, which has no
       custom styling and looks out of place next to the rest of the editor. */
    if (formEl.tagName === 'SELECT' && formEl.multiple) {
      buildMultiSelectField(formEl, panel);
      return panel;
    }

    /* check_box_group — a list/enumeration custom field with edit_tag_style
       "check_box" (checkboxes if multiple, radios if single-select), or a
       bool field with edit_tag_style "radio". Gets the same MultiSelect
       chip UI as a <select multiple> when it's checkboxes, or the same
       searchable single-select as user/version/enumeration when it's
       radios — same "pick from N options" shape, just built from
       <input>/<label> pairs instead of <option> tags. Checked before the
       format-based routing below since this is a structural check (any
       field_format can be configured this way), not a format-based one. */
    if (formEl.tagName === 'SPAN' && formEl.classList.contains('check_box_group')) {
      if (buildCheckBoxGroupField(formEl, panel)) return panel;
    }

    /* Bare boolean checkbox (bool CF, edit_tag_style "check_box") — give it
       the same searchable single-select UI as list/enumeration/user/version
       instead of a plain <input type="checkbox">, using the localized
       Yes/No options fetched into _cfBoolOptionsMap above. Falls through to
       the plain checkbox (sanitizeClone's checkbox branch) if that fetch
       hasn't completed yet — still functional, just not upgraded. */
    if (formEl.tagName === 'INPUT' && formEl.type === 'checkbox' && fieldName.startsWith('custom_field_values_')) {
      var boolCfId = fieldName.replace('custom_field_values_', '');
      var boolOpts = _cfBoolOptionsMap[boolCfId];
      if (boolOpts && boolOpts.length) {
        /* A bare checkbox is inherently binary (checked/unchecked) — Redmine's
           own single_check_box_edit_tag (lib/redmine/field_format.rb) has no
           blank state for this style regardless of is_required, so allowBlank
           is always false here, not gated on the CF's required flag. */
        buildBoolSelectField(formEl, boolOpts, panel, false);
        return panel;
      }
    }

    /* Custom field — use searchable for user/version/enumeration types.
       enumeration is structurally identical to user/version (all three are
       RecordList single-selects rendering a plain <select>) so it gets the
       same treatment for consistency; list-format single-selects are left
       on the plain .rf-select path below — that's a shared branch also
       used by native attribute dropdowns (status/priority/tracker/etc.),
       already reasonably styled, and not worth the added risk of touching.
       Require formEl to actually BE a <select> — the check_box_group branch
       above already handles the case where it isn't. */
    if (formEl.tagName === 'SELECT' && fieldName.startsWith('custom_field_values_')) {
      var cfId  = fieldName.replace('custom_field_values_', '');
      var cfFmt = _cfTypeMap[cfId];

      /* Boolean CF with edit_tag_style "" (Display: "Drop-down list", the
         default) renders as a plain <select> — until this branch was added
         it fell straight through to the generic clone below, which keeps
         Redmine's own native <select> intact. That native <select> always
         carries a blank/"please select" option for a required field with no
         default value (List#select_edit_tag in lib/redmine/field_format.rb
         adds it unconditionally, relying on server-side validation to reject
         an actual blank submission) — so the blank option was always selectable
         here even when required. Route it through the same searchable
         Yes/No widget as the checkbox style instead. On the issue show page,
         the blank option is never offered for a boolean dropdown regardless of
         is_required — only Yes/No — per explicit product decision (the
         issue LIST page's dropdown-style boolean still gates None on
         is_required, since that's a separate control/context). */
      if (cfFmt === 'bool') {
        var boolSelOpts = _cfBoolOptionsMap[cfId];
        if (boolSelOpts && boolSelOpts.length) {
          buildBoolSelectField(formEl, boolSelOpts, panel, false);
          return panel;
        }
      }

      if (cfFmt === 'user' || cfFmt === 'version' || cfFmt === 'enumeration') {
        var paramName = 'issue[custom_field_values][' + cfId + ']';
        buildSearchableField(formEl, valueEl, panel, paramName);
        return panel;
      }
    }

    var clone = formEl.cloneNode(true);
    /* Unique id to avoid duplicates */
    clone.id = (clone.id || '') + '_rf_dyn';
    sanitizeClone(clone, fieldName, panel);

    panel.appendChild(clone);
    return panel;
  }

  /** Build a SearchableSelect (Yes/No) for a boolean CF — either a bare
   *  checkbox (edit_tag_style "check_box") or a native <select>
   *  (edit_tag_style "" / Display "Drop-down list"). allowBlank is caller-
   *  controlled: the checkbox caller always passes false (a checkbox has no
   *  blank state to offer); the <select> caller passes !is_required so a
   *  required boolean dropdown never offers the blank option (see buildEditorPanel). */
  function buildBoolSelectField(formEl, boolOpts, panel, allowBlank) {
    var options = boolOpts.map(function (o) { return { id: String(o.id), name: o.label }; });
    var selectedId = formEl.tagName === 'SELECT'
      ? (formEl.value || null)
      : (formEl.checked ? '1' : '0');
    var ss = new RfIE.SearchableSelect(options, {
      selectedId:  selectedId,
      allowBlank:  !!allowBlank,
      minWidth:    '160px',
      onSelect: function (id) {
        doSave([{ name: formEl.name, value: id }], panel);
      }
    });
    panel.appendChild(ss);
  }

  /** Build a SearchableSelect for user/version fields that have many options. */
  function buildSearchableField(formEl, valueEl, panel, paramName) {
    /* Read all options from the native hidden select — already filtered by
       Redmine to the members/versions valid for this project. */
    var options = [];
    Array.from(formEl.querySelectorAll('option')).forEach(function (o) {
      if (o.value) options.push({ id: o.value, name: o.textContent.trim() });
    });

    /* Pre-select the currently displayed value */
    var displayWrap = valueEl.querySelector('.rf-show-display');
    var currentText = displayWrap ? displayWrap.textContent.trim() : '';
    var isBlank     = !currentText || currentText === '—' || currentText === '-';
    var selectedOpt = isBlank ? null : options.filter(function (o) { return o.name === currentText; })[0];

    var ss = new RfIE.SearchableSelect(options, {
      selectedId:  selectedOpt ? selectedOpt.id : null,
      allowBlank:  true,
      minWidth:    '160px',
      onSelect: function (id) {
        doSave([{ name: paramName, value: id || '' }], panel);
      }
    });

    panel.appendChild(ss);
  }

  /** Build a MultiSelect (chips + checkbox dropdown) for a multi-select field. */
  function buildMultiSelectField(formEl, panel) {
    var options = [];
    Array.from(formEl.querySelectorAll('option')).forEach(function (o) {
      if (o.value) options.push({ id: o.value, name: o.textContent.trim() });
    });

    /* Read pre-selected values from the native hidden select itself — it
       already reflects the issue's current values as rendered by Redmine,
       so there's no need to parse the (comma-joined) display text. */
    var selectedIds = Array.from(formEl.selectedOptions).map(function (o) { return o.value; });

    buildMultiSelectUI(options, selectedIds, formEl.name, panel);
  }

  /** Build a MultiSelect (chips + checkbox dropdown) for a check_box_group
   *  custom field (list/enumeration with edit_tag_style "check_box" and
   *  multiple=true, or a bool field with edit_tag_style "radio" is handled
   *  in the else-branch below instead — same UI component as a multi-select
   *  <select multiple>, since it's the same underlying "pick from N options"
   *  shape; only the source markup differs (checkboxes/radios vs <option>). */
  function buildCheckBoxGroupField(formEl, panel) {
    var inputs = Array.from(formEl.querySelectorAll('input[type="checkbox"], input[type="radio"]'));
    if (!inputs.length) return false;

    var options = inputs.map(function (inp) {
      var label = inp.closest('label');
      return { id: inp.value, name: label ? label.textContent.trim() : inp.value };
    });

    /* All inputs in the group share one `name` (Redmine renders every
       option's tag with the same tag_name — see check_box_edit_tag in
       lib/redmine/field_format.rb) — pick it up from whichever input. */
    var paramName = inputs[0].name;

    if (inputs[0].type === 'checkbox') {
      var selectedIds = inputs.filter(function (inp) { return inp.checked; })
        .map(function (inp) { return inp.value; });
      buildMultiSelectUI(options, selectedIds, paramName, panel);
    } else {
      /* Single-select rendered as radios — reuse the same searchable
         single-select used for user/version/enumeration <select> fields.
         allowBlank is false here (unlike buildSearchableField) because
         Redmine's own check_box_edit_tag (lib/redmine/field_format.rb)
         already adds its own "(none)" radio with value '' whenever the
         field is optional and not multiple — that's already present in
         `options`. Adding a second, synthetic blank option on top of it (via
         allowBlank: true) produced two indistinguishable blank entries in
         the dropdown. */
      var checkedInp = inputs.filter(function (inp) { return inp.checked; })[0];
      var ss = new RfIE.SearchableSelect(options, {
        selectedId:  checkedInp ? checkedInp.value : null,
        allowBlank:  false,
        minWidth:    '160px',
        onSelect: function (id) {
          doSave([{ name: paramName, value: id || '' }], panel);
        }
      });
      panel.appendChild(ss);
    }
    return true;
  }

  /** Shared UI for any "pick zero or more of N options" field — used by both
   *  a native <select multiple> (buildMultiSelectField) and a checkbox-style
   *  check_box_group (buildCheckBoxGroupField). paramName is the Rails
   *  array-param name (e.g. "issue[custom_field_values][5][]") shared by
   *  every value in the field. */
  function buildMultiSelectUI(options, selectedIds, paramName, panel) {
    var ms = new RfIE.MultiSelect(options, {
      selectedIds: selectedIds,
      minWidth:    '160px'
    });

    /* Icon check/cross buttons sit beside the field itself (not in a bar
       above it) — a multi-select is picked via several chip/checkbox
       toggles rather than one native change event, so a compact inline
       confirm/discard pair reads better here than a full text button bar. */
    var row = document.createElement('div');
    row.className = 'rf-ms-row';

    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'rf-icon-btn rf-icon-btn--cancel';
    cancelBtn.innerHTML = RfIE.icons.x;
    cancelBtn.setAttribute('aria-label', 'Cancel');
    cancelBtn.addEventListener('click', function () { closeEditor(panel); });

    var saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'rf-icon-btn rf-icon-btn--save';
    saveBtn.innerHTML = RfIE.icons.check;
    saveBtn.setAttribute('aria-label', 'Save');
    saveBtn.addEventListener('click', function () {
      var vals  = ms.getValues();
      /* An empty selection must still be sent so the server clears the
         field — a single pair with an empty value, matching how Redmine's
         own multi-value param (name ending "[]") is submitted when nothing
         is checked/selected. */
      var pairs = vals.length
        ? vals.map(function (v) { return { name: paramName, value: v }; })
        : [{ name: paramName, value: '' }];
      doSave(pairs, panel);
    });

    row.appendChild(ms);
    row.appendChild(cancelBtn);
    row.appendChild(saveBtn);
    panel.appendChild(row);
  }

  function sanitizeClone(clone, fieldName, panel) {
    /* Strip Redmine's inline event handlers (e.g. onchange="updateIssueFrom(...)") from
       the clone and all its descendants — prevents jQuery AJAX firing and showing #ajax-indicator. */
    (function stripHandlers(el) {
      Array.from(el.attributes || []).forEach(function (a) {
        if (/^on/i.test(a.name)) el.removeAttribute(a.name);
      });
      Array.from(el.children || []).forEach(stripHandlers);
    })(clone);

    /* Wire auto-save or enter-save depending on element type */
    var tag = clone.tagName.toLowerCase();

    if (tag === 'select' && !clone.multiple) {
      clone.className = 'rf-select';
      clone.addEventListener('change', function () {
        doSave([{ name: clone.name, value: clone.value }], panel);
      });
    }

    /* Note: select[multiple] never reaches here — buildEditorPanel routes
       multi-select fields to buildMultiSelectField (RfIE.MultiSelect)
       before cloning, so they get a proper chip/checkbox UI instead of a
       cloned bare native listbox. */

    if (tag === 'input' && clone.type === 'checkbox') {
      /* Single boolean custom field rendered as a real checkbox
         (edit_tag_style: "check_box" — lib/redmine/field_format.rb
         single_check_box_edit_tag). Previously fell through to the
         className = 'rf-input' branch below with no change listener at
         all — .rf-input's text-input styling (display:block, width:100%,
         padding, border) stretches/deforms a checkbox, and toggling it
         silently saved nothing. */
      clone.className = 'rf-checkbox';
      clone.addEventListener('change', function () {
        doSave([{ name: clone.name, value: clone.checked ? '1' : '0' }], panel);
      });
    } else if (tag === 'input') {
      clone.className = 'rf-input';
      if (clone.type === 'date') {
        /* Covers the issue's own start/due dates and every date-format
           custom field - both reach this same generic clone path. Enter,
           blur, the calendar picker and the wait-for-a-pause behaviour all
           live in the shared binding. */
        RfIE.bindDateInput(clone, function (value) {
          doSave([{ name: clone.name, value: value }], panel);
        });
      } else if (clone.type === 'text') {
        clone.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') {
            e.preventDefault();
            doSave([{ name: clone.name, value: clone.value }], panel);
          }
        });
      }
      if (clone.type === 'number' || clone.type === 'range') {
        clone.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') {
            e.preventDefault();
            doSave([{ name: clone.name, value: clone.value }], panel);
          }
        });
        if (clone.type === 'range') {
          clone.addEventListener('change', function () {
            doSave([{ name: clone.name, value: clone.value }], panel);
          });
        }
      }
    }

    if (tag === 'textarea') {
      clone.className = 'rf-textarea';
      clone.rows = 4;
      clone.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          doSave([{ name: clone.name, value: clone.value }], panel);
        }
      });
    }

    /* For check_box_group and similar containers — a list/enumeration custom
       field with edit_tag_style "check_box" (checkboxes if multiple, radios
       if single-select), or a bool field with edit_tag_style "radio". */
    if (clone.classList.contains('check_box_group')) {
      addSaveCancel(null, panel, function () {
        var inputs = clone.querySelectorAll('input[type="checkbox"], input[type="radio"]');
        var pairs = [];
        inputs.forEach(function (inp) {
          if (inp.checked) pairs.push({ name: inp.name, value: inp.value });
        });
        /* An empty selection must still be sent so the server can clear an
           optional field — same fix as buildMultiSelectField. Without this,
           unchecking everything and clicking Save silently did nothing
           (all inputs here share the same `name`, so any one of them gives
           the right field param to clear). */
        if (!pairs.length && inputs.length) {
          pairs.push({ name: inputs[0].name, value: '' });
        }
        doSave(pairs, panel);
      });
    }
  }

  function addSaveCancel(primaryEl, panel, onSave) {
    var bar = document.createElement('div');
    bar.className = 'rf-desc-editor-actions';

    var saveBtn = document.createElement('button');
    saveBtn.className = 'rf-btn rf-btn--primary';
    saveBtn.type = 'button';
    saveBtn.textContent = RfIE.i18n('save');
    saveBtn.addEventListener('click', onSave);

    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'rf-btn rf-btn--ghost';
    cancelBtn.type = 'button';
    cancelBtn.textContent = RfIE.i18n('cancel');
    cancelBtn.addEventListener('click', function () { closeEditor(panel); });

    bar.appendChild(cancelBtn);
    bar.appendChild(saveBtn);
    panel.appendChild(bar);
  }

  /* ────────────────────────────────────────────────────────────
     DESCRIPTION EDITOR
     ──────────────────────────────────────────────────────────── */
  function decorateDescription(details) {
    var descContainer = details.querySelector('.description');
    if (!descContainer) return;
    /* Guard against double-decoration */
    if (descContainer.dataset.rfDescDec) return;
    descContainer.dataset.rfDescDec = '1';

    var label = descContainer.querySelector('p strong');
    if (!label) return;

    var formTextarea = document.querySelector('#issue_description');
    if (!formTextarea) return;

    /* Use Redmine's jstToolbar wrapper (toolbar + textarea) so the user gets
       the full formatting toolbar, not a plain cloned textarea.
       Walk up from the textarea to find the jstBlock or ajax_upload_textarea
       wrapper that Redmine creates when it initialises jstToolbar. */
    var richEditor = formTextarea.closest('.jstBlock')
      || formTextarea.closest('.ajax_upload_textarea')
      || formTextarea;
    var richEditorParent  = richEditor.parentElement;
    var richEditorSibling = richEditor.nextSibling;

    /* Insert pencil after the Description heading */
    var icon = RfIE.dom.editIcon();
    label.insertAdjacentElement('afterend', icon);

    /* Editor wrapper — hidden by default, shown when editing */
    var editorWrap = document.createElement('div');
    editorWrap.className = 'rf-desc-editor-wrap';

    var actionBar = document.createElement('div');
    actionBar.className = 'rf-desc-editor-actions';

    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'rf-btn rf-btn--ghost';
    cancelBtn.textContent = RfIE.i18n('cancel');

    var saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'rf-btn rf-btn--primary';
    saveBtn.textContent = RfIE.i18n('save');

    actionBar.appendChild(cancelBtn);
    actionBar.appendChild(saveBtn);
    editorWrap.appendChild(actionBar);          /* action bar first so richEditor is inserted before it */
    descContainer.appendChild(editorWrap);

    var _descPasteHandler     = null;
    var _descDropHandler      = null;
    var _descPreviewHandler   = null;
    var _origAddInlineMarkup  = null;

    function openDesc() {
      if (editorWrap.classList.contains('rf-desc-editor-wrap--open')) return;
      /* Move Redmine's rich editor (jstBlock + toolbar) into our wrapper */
      editorWrap.insertBefore(richEditor, actionBar);
      editorWrap.classList.add('rf-desc-editor-wrap--open');
      /* Hide existing description content so editor replaces it visually */
      descContainer.classList.add('rf-desc-editing');
      var ta = richEditor.querySelector ? richEditor.querySelector('textarea') : richEditor;
      if (ta) {
        ta.focus();
        /* Place the cursor at the end of the text and clear any selection that
           survived from the previous editing session. Without this the browser
           restores whatever selection the user had before closing, which looks
           wrong when reopening the editor. */
        ta.selectionStart = ta.selectionEnd = ta.value.length;
      }

      /* Replace addInlineAttachmentMarkup for the lifetime of this edit session.
         Redmine's implementation checks handleFileDropEvent.target for class
         wiki-edit; that property is only the textarea when the user drops
         precisely on it — drops on the toolbar, action bar, or editorWrap set
         it to a non-wiki-edit element, so the function returns early and
         inserts nothing. Our replacement inserts the correct markup directly
         into the description
         textarea without relying on the toolbar button. It detects the active
         text format from the same source Redmine core uses (attachments.js
         reads document.body's data-text-formatting attribute, set in
         app/views/layouts/base.html.erb from Setting.text_formatting):
           textile     → !filename!
           common_mark → ![](filename)
         (NOTE: a prior version of this code tried to detect the format by
         checking for a '.jstb_img' toolbar button, on the theory that only
         textile.js registers it. That's wrong — common_mark.js registers an
         'img' toolbar element too (app/assets/javascripts/jstoolbar/common_mark.js),
         which jstoolbar.js renders with the same '.jstb_img' class either way.
         So that check was always true and always produced textile syntax,
         which is invalid under this app's default common_mark format —
         explaining why pasted images never rendered, in the saved
         description or in the toolbar's own Preview.) */
      if (typeof window.addInlineAttachmentMarkup === 'function') {
        _origAddInlineMarkup = window.addInlineAttachmentMarkup;
        window.addInlineAttachmentMarkup = function (file) {
          if (!ta) { _origAddInlineMarkup(file); return; }
          var mimeTypes = window.wikiImageMimeTypes;
          if (!mimeTypes || mimeTypes.indexOf(file.type) === -1) return;

          var sanitized = file.name.replace(/[\/\?\%\*\:\|\"\'<>\n\r]+/g, '_');
          var encoded   = encodeURIComponent(sanitized)
            .replace(/[!()]/g, function (c) { return '%' + c.charCodeAt(0).toString(16); });

          var textFormat = document.body.getAttribute('data-text-formatting')
            || (window.RfIE && RfIE.config && RfIE.config.textFormat)
            || 'textile';
          var prefix = (textFormat === 'textile') ? '!' : '![](';
          var suffix = (textFormat === 'textile') ? '!' : ')';

          var pos  = ta.selectionStart | 0;
          var text = ta.value;
          var before = text.slice(0, pos);
          var after  = text.slice(pos);

          /* If the cursor sits right inside an empty prefix/suffix pair — e.g.
             the user clicked the toolbar's own Image button first, which
             (via jstoolbar.js encloseSelection) inserts "![]()" / "!!" and
             places the cursor between them waiting for a filename — insert
             the bare filename there instead of a second, nested !()!()
             image marker. Otherwise insert the full wrapped markup at the
             cursor as before. */
          if (before.slice(-prefix.length) === prefix && after.slice(0, suffix.length) === suffix) {
            ta.value = before + encoded + after;
            ta.selectionStart = ta.selectionEnd = pos + encoded.length;
          } else {
            var pre  = (pos > 0 && !/[\r\n]/.test(before.charAt(before.length - 1))) ? '\n' : '';
            var post = (after.length > 0 && !/[\r\n]/.test(after.charAt(0))) ? '\n' : '';
            var imgMarkup = prefix + encoded + suffix;

            ta.value = before + pre + imgMarkup + post + after;
            ta.selectionStart = ta.selectionEnd = pos + pre.length + imgMarkup.length + post.length;
          }
        };
      }

      /* Re-forward paste/drop events to Redmine's attachment upload handlers.
         setupFileDrop() in attachments.js binds copyImageFromClipboard and
         handleFileDropEvent on #issue-form .box at DOMReady. Moving the jstBlock
         out of that container breaks the bubble path. We restore it by catching
         those events on editorWrap and delegating to the original .box element,
         keeping all upload logic in Redmine core (no duplication). */
      var box = document.querySelector('#issue-form div.box');
      if (box) {
        if (typeof copyImageFromClipboard === 'function') {
          _descPasteHandler = function (e) { copyImageFromClipboard.call(box, e); guardPendingUpload(); };
          editorWrap.addEventListener('paste', _descPasteHandler);
        }
        if (typeof handleFileDropEvent === 'function') {
          _descDropHandler = function (e) { handleFileDropEvent.call(box, e); guardPendingUpload(); };
          editorWrap.addEventListener('drop',     _descDropHandler);
          editorWrap.addEventListener('dragover', function (e) { e.preventDefault(); });
        }
      }

      /* Redmine's wikitoolbar Preview tab fetches its rendered HTML via a
         handler delegated on #content (application-legacy.js), which reads
         attachment tokens via tab.parents('form'). Since the jstBlock now
         lives in editorWrap (a sibling of #issue-form, not a descendant),
         that lookup finds no form at all — the preview request goes out
         with zero attachment tokens, so a pending (not-yet-saved) pasted
         image can never resolve in Preview. Intercept the click here first
         and stopPropagation so the (broken, in this context) core handler
         never runs, then replicate its request using #issue-form directly
         as the attachment token source — same pattern as the
         addInlineAttachmentMarkup override above. */
      _descPreviewHandler = function (e) {
        var tab = e.target.closest ? e.target.closest('.tab-preview') : null;
        if (!tab) return;
        e.stopPropagation();
        var url = tab.getAttribute('data-url');
        var jstBlockEl = tab.closest('.jstBlock');
        var wikiEdit = jstBlockEl ? jstBlockEl.querySelector('.wiki-edit') : null;
        if (!url || !wikiEdit || !window.$) return;
        var text = encodeURIComponent(wikiEdit.value);
        var attachments = window.$('#issue-form .attachments_fields input').serialize();
        window.$.ajax({
          url: url,
          type: 'post',
          data: 'text=' + text + (attachments ? '&' + attachments : ''),
          success: function (data) {
            var previewEl = jstBlockEl.querySelector('.wiki-preview');
            if (previewEl) previewEl.innerHTML = data;
          }
        });
      };
      editorWrap.addEventListener('click', _descPreviewHandler);
    }

    var _uploadGuardTimer = null;

    /* Redmine's own upload code disables the form's submit button while an
       attachment upload is in flight (attachments.js onLoadstart, scoped to
       $(this).parents('form')) specifically so the form can't be submitted
       before the attachment token/markup is ready. Our Save button lives
       outside #issue-form, so that guard never sees it — without this, a
       quick Save click right after pasting/dropping an image saves the
       description before the upload finishes, silently dropping the image
       (empty token, no inline markup). Poll the same ajaxUpload.uploading
       counter Redmine core uses and hold Save disabled until it's back to 0. */
    function guardPendingUpload() {
      if (typeof window.ajaxUpload === 'undefined') return;
      saveBtn.disabled = true;
      if (_uploadGuardTimer) clearInterval(_uploadGuardTimer);
      var checks = 0;
      _uploadGuardTimer = setInterval(function () {
        checks++;
        if (!window.ajaxUpload.uploading || checks > 300) {
          clearInterval(_uploadGuardTimer);
          _uploadGuardTimer = null;
          saveBtn.disabled = false;
        }
      }, 100);
    }

    function closeDesc() {
      editorWrap.classList.remove('rf-desc-editor-wrap--open');
      descContainer.classList.remove('rf-desc-editing');
      /* Move rich editor back to its original location in the issue form */
      if (richEditor.parentElement === editorWrap) {
        if (richEditorParent && document.contains(richEditorParent)) {
          if (richEditorSibling && richEditorSibling.parentElement === richEditorParent) {
            richEditorParent.insertBefore(richEditor, richEditorSibling);
          } else {
            richEditorParent.appendChild(richEditor);
          }
        }
      }
      /* Restore the original addInlineAttachmentMarkup so uploads outside the
         description editor (e.g. from the standard issue edit form) are unaffected. */
      if (_origAddInlineMarkup) {
        window.addInlineAttachmentMarkup = _origAddInlineMarkup;
        _origAddInlineMarkup = null;
      }
      if (_descPasteHandler)   { editorWrap.removeEventListener('paste', _descPasteHandler);   _descPasteHandler   = null; }
      if (_descDropHandler)    { editorWrap.removeEventListener('drop',  _descDropHandler);    _descDropHandler    = null; }
      if (_descPreviewHandler) { editorWrap.removeEventListener('click', _descPreviewHandler);  _descPreviewHandler = null; }
      if (_uploadGuardTimer) { clearInterval(_uploadGuardTimer); _uploadGuardTimer = null; }
      saveBtn.disabled = false;
    }

    icon.addEventListener('click', function (e) {
      e.stopPropagation();
      openDesc();
    });

    saveBtn.addEventListener('click', function () {
      var ta = richEditor.querySelector ? richEditor.querySelector('textarea') : richEditor;
      if (!ta) return;
      var val = ta.value;

      /* Show saving state in the action bar */
      saveBtn.disabled  = true;
      cancelBtn.disabled = true;
      var spinnerEl = RfIE.dom.spinner();
      var textEl    = document.createElement('span');
      textEl.className   = 'rf-saving-text';
      textEl.textContent = ' ' + RfIE.i18n('saving');
      actionBar.insertBefore(spinnerEl, cancelBtn);
      actionBar.insertBefore(textEl,    cancelBtn);

      function cleanup() {
        spinnerEl.remove();
        textEl.remove();
        saveBtn.disabled  = false;
        cancelBtn.disabled = false;
      }

      var fields = {};
      fields[formTextarea.name] = val;
      var lockVers = document.querySelector('#issue_lock_version');
      if (lockVers) fields['issue[lock_version]'] = lockVers.value;

      /* Collect attachment tokens for any images uploaded during this edit.
         Redmine's ajaxUpload writes token/filename hidden inputs into
         #issue-form .attachments_fields after each upload. We must include
         them in the PATCH so the server associates the files with the issue. */
      document.querySelectorAll('#issue-form .attachments_fields input').forEach(function (inp) {
        if (inp.name && !inp.disabled) fields[inp.name] = inp.value || '';
      });

      RfIE.api.patchForm(issueUrl(), fields)
        .then(function (html) {
          var freshDoc = RfIE.sanitizeDoc(new DOMParser().parseFromString(html, 'text/html'));
          /* A successful PATCH redirects to the issue show page (patchForm follows
             the opaque redirect with a fresh GET). A stale lock_version causes
             Redmine to render the edit form instead of redirecting — detect this
             before treating the response as a success. */
          if (!freshDoc.querySelector('.issue.details')) {
            cleanup();
            RfIE.toast.error(RfIE.i18n('couldNotSave') + ' ' + RfIE.i18n('staleObjectConflict'));
            return;
          }
          /* This save goes through Redmine's own update action, which drops any
             attribute the user is no longer allowed to change rather than
             refusing the request outright. It still redirects back to the issue
             afterwards, so landing here is not by itself proof that anything was
             saved - a user whose edit rights were taken away mid-edit got a
             cheerful "Saved successfully" for a change that never happened
             (#121122). The returned page carries the description the server
             actually kept, in the edit form's own textarea; if that is not what
             was just sent, say so instead of claiming success. */
          var savedField = freshDoc.querySelector('#issue-form [name="' + formTextarea.name + '"]');
          var normalise  = function (s) { return String(s).replace(/\r\n/g, '\n'); };
          if (!savedField || normalise(savedField.value) !== normalise(val)) {
            cleanup();
            RfIE.toast.error(RfIE.i18n('couldNotSave') + ' ' + RfIE.i18n('noPermissionIssue'));
            return;
          }
          cleanup();
          closeDesc();
          refreshDescriptionView(freshDoc);
          /* Sync lock_version and CSRF token from the fresh page HTML.
             patchForm returns the full issue show page on success but the
             DOM's #issue_lock_version is not otherwise updated after a
             description save. Without this, every save after the first sends
             the original lock_version, which Redmine rejects as a stale
             conflict — causing all subsequent description saves to silently fail. */
          var newLv = freshDoc.querySelector('#issue_lock_version');
          var curLv = document.querySelector('#issue_lock_version');
          if (newLv && curLv) curLv.value = newLv.value;
          var newToken = freshDoc.querySelector('input[name="authenticity_token"]');
          if (newToken) RfIE.csrf.update(newToken.value);
          /* Clear the attachment token spans #issue-form .attachments_fields just
             submitted. addFile() (attachments.js) never removes them once uploaded,
             and unlike the attribute-save path (processResponse replaces the whole
             #issue-form innerHTML), this path only touches .description — so a
             consumed token stays in the DOM and gets resent on the NEXT description
             save. The server rejects an already-attached token (Attachment.find_by_token
             requires container.nil?), which fails issue.save with a validation error —
             not a lock_version conflict — but produces the same "no .issue.details in
             response" signal above, surfacing as a misleading stale-conflict toast. */
          var attachmentsFields = document.querySelector('#issue-form .attachments_fields');
          if (attachmentsFields) attachmentsFields.innerHTML = '';
          /* Clear the jQuery dirty flag that warnLeavingUnsaved() set when the
             textarea was edited. Normally Redmine clears it via a 'submit' event
             on the form, but patchForm uses fetch — no submit fires, so the flag
             survives and triggers the "Changes may not be saved" browser warning
             on the next navigation. Match exactly what Redmine's submit handler
             does: $('textarea').removeData('changed'). */
          if (window.$) window.$('textarea').removeData('changed');
          /* Saving the description adds a journal entry just like any other
             change, so the tabs have to be brought up to date too. This path
             posts the form itself and never reaches processResponse, so it
             has to ask for the refresh on its own - freshDoc is the response
             already fetched above, so this costs no extra request. */
          refreshHistorySection(freshDoc);
          RfIE.toast.success(RfIE.i18n('savedSuccessfully'));
        })
        .catch(function (err) {
          cleanup();
          RfIE.toast.error(RfIE.i18n('couldNotSave') + ' ' + (err.message || RfIE.i18n('unknownError')));
        });
    });

    cancelBtn.addEventListener('click', closeDesc);
  }

  function refreshDescriptionView(freshDoc) {
    var newDesc = freshDoc.querySelector('.issue.details .description');
    var curDesc = document.querySelector('.issue.details .description');
    if (!newDesc || !curDesc) return;

    var newWiki = newDesc.querySelector('.wiki');
    var curWiki = curDesc.querySelector('.wiki');
    if (newWiki && curWiki) {
      curWiki.innerHTML = newWiki.innerHTML;
    } else if (newWiki) {
      /* No wiki div yet (empty description before first save) — insert one */
      var wiki = document.createElement('div');
      wiki.className = 'wiki';
      wiki.innerHTML = newWiki.innerHTML;
      curDesc.insertBefore(wiki, curDesc.querySelector('.rf-desc-editor-wrap'));
    }
  }

  /* ────────────────────────────────────────────────────────────
     SUBJECT EDITOR
     ──────────────────────────────────────────────────────────── */
  /* Whether the subject can be edited depends on the issue's status: a workflow
     rule can make it read-only at one status and editable at the next. Redmine
     says which by either putting a subject box in its own edit form or leaving
     it out, and decorateSubject only adds the pencil when that box is there.

     That runs once, at page load. Changing the status inline used to leave the
     pencil exactly as it was found, so moving off a status that locked the
     subject left it looking permanently uneditable until the page was reloaded
     - see #121114. Custom fields never had the problem because they work this
     out again for themselves. Called after each save refreshes the form, so the
     pencil matches the status the issue is actually at now. */
  function syncSubjectEditor() {
    var details = document.querySelector('.issue.details');
    if (!details) return;
    var subjectDiv = details.querySelector('.subject');
    var h3 = subjectDiv && subjectDiv.querySelector('h3');
    if (!h3) return;

    var editable  = !!document.querySelector('#issue_subject');
    var pencil    = h3.querySelector('.rf-edit-icon');
    if (!!pencil === editable) return;

    /* Drop whatever decorateSubject left behind - its handlers still point at
       the form controls from before the refresh. */
    if (pencil) pencil.remove();
    var stalePanel = subjectDiv.querySelector('.rf-show-editor');
    if (stalePanel) stalePanel.remove();

    if (editable) decorateSubject(details);
  }

  function decorateSubject(details) {
    var subjectDiv = details.querySelector('.subject');
    if (!subjectDiv) return;

    var h3 = subjectDiv.querySelector('h3');
    if (!h3) return;

    /* h3's immediate DOM parent — NOT subjectDiv itself. Redmine wraps the
       subject h3 in its own unclassed <div> (render_issue_subject_with_tree),
       and for issues that have a parent/ancestor, that wrapper sits nested
       one level inside subjectDiv, alongside a sibling <p> breadcrumb link —
       so subjectDiv can have the breadcrumb <p> as an extra flex item. The
       editor panel must be appended next to h3 in its own wrapper, not as a
       sibling of that wrapper under subjectDiv, or it gets squeezed into a
       sliver by the long unwrapped breadcrumb text and floats off to the
       side instead of sitting where the subject line actually is. */
    var subjectRow = h3.parentNode;

    var formInput = document.querySelector('#issue_subject');
    if (!formInput) return;

    var icon = RfIE.dom.editIcon();
    h3.appendChild(icon);

    /* Build inline input */
    var editorPanel = document.createElement('div');
    editorPanel.className = 'rf-show-editor';
    editorPanel.style.width = '100%';

    var inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'rf-input';
    inp.value = formInput.value;
    inp.name  = formInput.name;
    inp.style.width = '100%';
    inp.style.boxSizing = 'border-box';

    editorPanel.appendChild(inp);
    subjectRow.appendChild(editorPanel);

    var disposeOutside = null;
    var disposeEsc     = null;

    icon.addEventListener('click', function (e) {
      e.stopPropagation();
      openEditor(editorPanel, subjectRow, icon);
      /* openEditor() already focuses the input, but leaves the cursor
         wherever the browser puts it by default (start of text) — place it
         at the end instead, so editing continues from where the subject
         text left off rather than requiring the user to move it manually. */
      inp.focus();
      inp.selectionStart = inp.selectionEnd = inp.value.length;
      disposeOutside = RfIE.onClickOutside(editorPanel, function () {
        closeEditor(editorPanel);
        cleanup();
      });
      disposeEsc = RfIE.onEscape(function () {
        closeEditor(editorPanel);
        cleanup();
      });
    });

    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (!inp.value.trim()) {
          RfIE.toast.error(RfIE.i18n('subjectBlank'));
          return;
        }
        cleanup();
        /* Show the new subject immediately. doSave's own success handling
           runs closeEditor() as soon as the PUT resolves (to un-hide h3),
           but the corrective GET + processResponse that would otherwise
           refresh h3's text takes a couple more seconds — without this,
           closeEditor() reveals h3 still showing the OLD subject for that
           whole gap, before finally flipping to the new one once the
           slower round trip completes. Other fields avoid this via
           optimisticShowUpdate, which subject doesn't use (no
           .rf-show-display wrapper on h3), so set it directly here. */
        h3.textContent = inp.value;
        h3.appendChild(icon); /* textContent clears all children — re-attach pencil */
        doSave([{ name: formInput.name, value: inp.value }], editorPanel, false, function (html) {
          /* Confirm/correct from the server-rendered value once the slower
             round trip lands (e.g. if Redmine normalized the text). */
          var newDoc = RfIE.sanitizeDoc(new DOMParser().parseFromString(html, 'text/html'));
          var newH3 = newDoc.querySelector('.issue.details .subject h3');
          if (newH3) {
            h3.textContent = newH3.textContent;
            h3.appendChild(icon);
          }
          closeEditor(editorPanel);
        });
      }
    });

    function cleanup() {
      if (disposeOutside) { disposeOutside(); disposeOutside = null; }
      if (disposeEsc)     { disposeEsc();     disposeEsc     = null; }
    }
  }

  /* ────────────────────────────────────────────────────────────
     SPRINT & STORY POINTS (agile plugin fields)
     These fields have no native <select> on the show page — options
     are fetched from our proxy endpoints on first click.
     ──────────────────────────────────────────────────────────── */

  /* Lazily resolved project id for the current issue show page */
  var _showProjectId = null;

  function resolveShowProjectId(cb) {
    if (_showProjectId) return cb(_showProjectId);
    var issueId = RfIE.config.issueId;
    if (!issueId) return cb(null);
    RfIE.api.get(BASE + '/issues/' + issueId + '/rf_issue')
      .then(function (d) {
        _showProjectId = d.issue && d.issue.project ? String(d.issue.project.id) : null;
        cb(_showProjectId);
      })
      .catch(function () { cb(null); });
  }

  /* Build a bare agile-field editor that fetches its options on first open.
     fetchOptions(cb) must call cb([ {value, label}, … ]) when ready.
     onSave(selectEl, panel) is called on <select> change. */
  function decorateAgileFieldAsync(attrEl, fetchOptions, onSave) {
    if (!attrEl || attrEl.dataset.rfAgileDec) return;
    attrEl.dataset.rfAgileDec = '1';

    var valueEl = attrEl.querySelector('.value');
    if (!valueEl) return;

    var displayWrap = document.createElement('span');
    displayWrap.className = 'rf-show-display';
    while (valueEl.firstChild) { displayWrap.appendChild(valueEl.firstChild); }
    valueEl.appendChild(displayWrap);

    var icon = RfIE.dom.editIcon();
    valueEl.appendChild(icon);

    var panel = document.createElement('div');
    panel.className = 'rf-show-editor';
    valueEl.appendChild(panel);

    attrEl.addEventListener('mouseenter', function () {
      if (!valueEl.classList.contains('rf-value-editing')) icon.style.opacity = '0.7';
    });
    attrEl.addEventListener('mouseleave', function () {
      if (!valueEl.classList.contains('rf-value-editing')) icon.style.opacity = '0';
    });

    var built = false;

    icon.addEventListener('click', function (e) {
      e.stopPropagation();
      if (built) { openEditor(panel, valueEl, icon); return; }

      /* Show spinner inside the panel while loading */
      var spin = RfIE.dom.spinner();
      panel.appendChild(spin);
      openEditor(panel, valueEl, icon);

      fetchOptions(function (opts) {
        if (spin.parentNode) spin.parentNode.removeChild(spin);
        if (!opts || !opts.length) { closeEditor(panel); return; }

        var sel = document.createElement('select');
        sel.className = 'rf-select';

        var blank = document.createElement('option');
        blank.value = '';
        blank.textContent = RfIE.i18n('none');
        sel.appendChild(blank);

        var currentText = displayWrap.textContent.trim();
        opts.forEach(function (o) {
          var opt = document.createElement('option');
          opt.value = o.value;
          opt.textContent = o.label;
          if (o.label === currentText) opt.selected = true;
          sel.appendChild(opt);
        });

        sel.addEventListener('change', function () { onSave(sel, panel); });
        panel.appendChild(sel);
        built = true;
      });
    });
  }

  function decorateSprint(details) {
    var attrEl = details.querySelector('.attribute.sprint');
    decorateAgileFieldAsync(
      attrEl,
      function (cb) {
        resolveShowProjectId(function (projId) {
          if (!projId) return cb([]);
          RfIE.api.get(BASE + '/projects/' + projId + '/fetch_sprints')
            .then(function (data) {
              cb((data.sprints || []).map(function (s) {
                return { value: String(s.id), label: s.name };
              }));
            })
            .catch(function () { cb([]); });
        });
      },
      function (sel, panel) {
        doSave([{ name: 'issue[sprint_craft_id]', value: sel.value }], panel);
      }
    );
  }

  function decorateStoryPoints(details) {
    var attrEl = details.querySelector('.attribute.story-points');
    decorateAgileFieldAsync(
      attrEl,
      function (cb) {
        RfIE.api.get(BASE + '/agile_story_points')
          .then(function (data) {
            cb((data.story_point_values || []).map(function (v) {
              return { value: String(v), label: String(v) };
            }));
          })
          .catch(function () { cb([]); });
      },
      function (sel, panel) {
        var val = sel.value === '0' ? '' : sel.value;
        doSave([{ name: 'issue[story_points]', value: val }], panel);
      }
    );
  }

  /* ────────────────────────────────────────────────────────────
     OPEN / CLOSE EDITOR PANELS
     ──────────────────────────────────────────────────────────── */
  var _currentPanel    = null;
  var _disposeOutside  = null;
  var _disposeEsc      = null;

  function openEditor(panel, container, icon) {
    /* Close any already-open panel */
    if (_currentPanel && _currentPanel !== panel) {
      closeEditor(_currentPanel);
    }

    /* Hide the display text and pencil so only the editor is visible inline */
    container.classList.add('rf-value-editing');
    panel.classList.add('rf-show-editor--open');
    _currentPanel = panel;

    /* Focus the first interactive element */
    var first = panel.querySelector('input, select, textarea');
    if (first) first.focus();

    /* Click outside → close */
    if (_disposeOutside) _disposeOutside();
    _disposeOutside = RfIE.onClickOutside(panel, function () {
      closeEditor(panel);
    });
    if (_disposeEsc) _disposeEsc();
    _disposeEsc = RfIE.onEscape(function () {
      closeEditor(panel);
    });
  }

  function closeEditor(panel) {
    panel.classList.remove('rf-show-editor--open');
    if (_currentPanel === panel) _currentPanel = null;
    /* Restore display text and pencil */
    if (panel.parentElement) {
      panel.parentElement.classList.remove('rf-value-editing');
    }
    if (_disposeOutside) { _disposeOutside(); _disposeOutside = null; }
    if (_disposeEsc)     { _disposeEsc();     _disposeEsc     = null; }
  }

  /* ────────────────────────────────────────────────────────────
     SAVE — use our partial-update endpoint (save(validate:false))
     so unrelated required custom fields do not block single-field edits.
     ──────────────────────────────────────────────────────────── */

  /* Convert flat form pairs { "issue[field]": val } to nested JSON for our API.
     Multi-value fields (multi-select custom fields, checkbox-group custom
     fields) submit every selected option under the SAME Rails array-param
     name, e.g. "issue[custom_field_values][5][]" — doSave's fields object
     already collapses same-name pairs into a real array for any name ending
     in "[]" (see doSave below), so here we just need to strip that "[]"
     suffix to find the base key; the old regex tried to also parse a
     numeric index bracket (`[(\d+)]`) that Redmine never actually emits for
     this shape, and its laziness silently mismatched on names like
     "issue[custom_field_values][5][]" — producing a garbled key
     ("5][") that never matched any real custom field, so the save was a
     silent no-op server-side. */
  function buildShowIssueBody(fields) {
    var issue = {};
    Object.keys(fields).forEach(function (k) {
      var isArrayParam = /\[\]$/.test(k);
      var baseKey = isArrayParam ? k.slice(0, -2) : k;
      var m = baseKey.match(/^issue\[(.+?)\](?:\[(.+?)\])?$/);
      if (!m) return;
      var value = fields[k];
      if (m[1] === 'custom_field_values') {
        if (!issue.custom_field_values) issue.custom_field_values = {};
        issue.custom_field_values[m[2]] = value;
      } else {
        issue[m[1]] = value;
      }
    });
    return { issue: issue };
  }

  /* Immediately write the new value into .rf-show-display so the user sees the
     updated value the instant the editor closes, with no flash of the old value
     while the GET re-fetch is in progress.  processResponse then confirms
     (or corrects) the value once the server response arrives. */
  function optimisticShowUpdate(panel) {
    var valueEl = panel.parentElement;
    if (!valueEl) return;
    var displayWrap = valueEl.querySelector('.rf-show-display');
    if (!displayWrap) return;

    /* RfIE.MultiSelect (chip/checkbox multi-select) — show comma-separated
       labels. Must be checked before the generic `input` fallback below,
       since .rf-ms contains its own search text input (.rf-ms__input) whose
       value is just the (now-cleared) filter text, not the selection. */
    var ms = panel.querySelector('.rf-ms');
    if (ms && typeof ms.getNames === 'function') {
      var msNames = ms.getNames();
      displayWrap.textContent = msNames.length ? msNames.join(', ') : '—';
      return;
    }

    /* Multi-select — show comma-separated labels */
    var multiSel = panel.querySelector('select[multiple]');
    if (multiSel) {
      var labels = Array.from(multiSel.selectedOptions).map(function (o) { return o.textContent.trim(); });
      displayWrap.textContent = labels.length ? labels.join(', ') : '—';
      return;
    }

    /* check_box_group (list/enumeration/bool custom field rendered as a
       checkbox or radio group) — show the checked option(s)' label text.
       Must be checked before the generic `input` fallback below, which
       would otherwise grab the FIRST checkbox/radio in the group regardless
       of whether it's actually checked. */
    var cbGroup = panel.querySelector('.check_box_group');
    if (cbGroup) {
      var checkedLabels = Array.from(cbGroup.querySelectorAll('input:checked')).map(function (inp) {
        var label = inp.closest('label');
        return label ? label.textContent.trim() : inp.value;
      });
      displayWrap.textContent = checkedLabels.length ? checkedLabels.join(', ') : '—';
      return;
    }

    /* Single select */
    var sel = panel.querySelector('select');
    if (sel) {
      var opt = sel.options[sel.selectedIndex];
      if (opt) displayWrap.textContent = opt.textContent.trim();
      return;
    }

    /* Date input — format ISO to user's display format */
    var dateInp = panel.querySelector('input[type="date"]');
    if (dateInp) {
      displayWrap.textContent = dateInp.value ? RfIE.dateUtils.toDisplay(dateInp.value) : '—';
      return;
    }

    /* Bare boolean checkbox (bool custom field, edit_tag_style "check_box").
       Its .value is Redmine's static check_box_tag(tag_name, '1', ...) —
       always the string "1" whether checked or not — so the generic input
       branch below would show "1" regardless of the real new state. The
       real localized Yes/No text (app/helpers/application_helper.rb) isn't
       available anywhere client-side for this control (no adjacent label,
       no Yes/No <option> to borrow from), so rather than guess/hardcode an
       English string that could mismatch the site's locale, leave the old
       display text in place — the corrective GET a moment later
       (processResponse) replaces it with the correct server-rendered
       Yes/No text anyway. */
    var boolCb = panel.querySelector('input[type="checkbox"]');
    if (boolCb) return;

    /* Text / number input (also catches SearchableSelect's hidden text input) */
    var inp = panel.querySelector('input');
    if (inp) {
      displayWrap.textContent = inp.value || '—';
      return;
    }

    /* Textarea (text-format custom field). Its read-only display is
       server-rendered as a block-level `<div class="wiki">...</div>` wrapper
       (custom_field_value_tag in app/helpers/custom_fields_helper.rb, only
       emitted when the value is present) so the CSS `flow-root` fix on
       `.value` (rf_inline_editor.css) can clear the floated `.label` beside
       it. Overwriting displayWrap with plain text here — as the generic
       input branch above does — would destroy that wrapper and any
       formatting (paragraphs, links, line breaks) for the ~1-3s the
       corrective GET below takes to arrive, and would leave the field
       permanently unwrapped/plain if that GET ever fails. Exactly like the
       boolCb case above: leave the old (still-wrapped) display text in
       place and let the corrective GET (processResponse) supply the fresh
       server-rendered HTML. */
    var ta = panel.querySelector('textarea');
    if (ta) return;
  }

  function doSave(pairs, panel, keepOpen, onSuccess) {
    /* Prevent double-save */
    if (panel.dataset.rfSaving) return;
    panel.dataset.rfSaving = '1';

    /* Hide interactive elements (preserves DOM + event listeners) and show
       spinner in the same position — do NOT replace innerHTML which would
       destroy the original form element and leave a stale spinner on re-open.
       .rf-ss covers SearchableSelect wrappers (assignee, version); .rf-ms
       covers MultiSelect wrappers (multi-select custom fields). */
    var interactives = Array.from(panel.querySelectorAll('input, select, textarea, button, .rf-ss, .rf-ms'));
    interactives.forEach(function (el) { el.style.display = 'none'; });

    var spinnerEl = document.createElement('span');
    spinnerEl.className = 'rf-spinner';
    var textEl = document.createElement('span');
    textEl.className = 'rf-saving-text';
    textEl.textContent = ' ' + RfIE.i18n('saving');
    /* Insert before the first child so spinner occupies the same spot as the field */
    panel.insertBefore(spinnerEl, panel.firstChild);
    panel.insertBefore(textEl, spinnerEl.nextSibling);

    /* pairs may contain several entries sharing the same `name` — every
       checked box in a multi-value check_box_group, or every selected
       option in a multi-select, is sent as one pair per value under the
       same Rails array-param name (e.g. "issue[custom_field_values][5][]").
       A plain fields[p.name] = p.value here would let only the LAST pair
       survive (object key collision), silently dropping every other
       checked/selected value. Names ending in "[]" always become a real
       array — even for a single value — matching how a native HTML form
       with name="x[]" is parsed by Rails regardless of how many values
       were submitted under that name. */
    var fields = {};
    pairs.forEach(function (p) {
      if (/\[\]$/.test(p.name)) {
        if (!Array.isArray(fields[p.name])) fields[p.name] = [];
        fields[p.name].push(p.value);
      } else {
        fields[p.name] = p.value;
      }
    });

    /* Add lock version to avoid silent conflicts */
    var lockVers = document.querySelector('#issue_lock_version');
    if (lockVers) fields['issue[lock_version]'] = lockVers.value;

    function cleanup() {
      delete panel.dataset.rfSaving;
      spinnerEl.remove();
      textEl.remove();
      interactives.forEach(function (el) { el.style.display = ''; });
    }

    var issueId = RfIE.config.issueId;

    /* Use our endpoint (save(validate:false)) so a required custom field that
       was never filled does not block editing an unrelated field. If some
       OTHER required field IS blank, the endpoint refuses outright (see
       issue_tables_controller.rb) and responds with redirect_to_edit instead
       — handled below via .catch, since that response comes back as a 422. */
    RfIE.api.put(BASE + '/issues/' + issueId + '/update_field', buildShowIssueBody(fields))
      .then(function (saved) {
        /* The save raised the issue's lock version. Take the new one at once, so a second quick edit
           does not go out with the old one and get refused as a conflict. */
        var lockEl = document.querySelector('#issue_lock_version');
        if (lockEl && saved && saved.issue && saved.issue.lock_version != null) lockEl.value = saved.issue.lock_version;
        cleanup();
        /* Show the new value immediately so there is no flash of the old value
           while the GET re-fetch is in progress. */
        if (!keepOpen) optimisticShowUpdate(panel);
        /* Close the editor BEFORE processResponse — the fallback attribute-update
           loop inside processResponse skips any attribute that still has the
           .rf-value-editing class — if we close after, the just-saved field
           gets skipped and keeps showing the old value. */
        if (!keepOpen) closeEditor(panel);
        /* Announce success as soon as the actual save (PUT) resolves, not
           after the slower corrective GET below — this endpoint saves with
           validate:false specifically so it always succeeds (see comment
           above), so a resolved PUT is already a reliable success signal;
           waiting for the GET + processResponse just to fire this toast
           made "Saved successfully" show up a couple of seconds late for
           no real benefit. The GET below still runs to refresh any other
           attributes that changed as a side effect of this save. */
        RfIE.toast.success(RfIE.i18n('savedSuccessfully'));
        /* Re-fetch the issue page for fresh HTML to pass to processResponse.
           cache:'reload' ensures we get the server's latest version, not a
           browser-cached copy. */
        return fetch(issueUrl(), { credentials: 'same-origin', cache: 'reload' })
          .then(function (r) { return r.text(); });
      })
      .then(function (html) {
        var hasError = processResponse(html);
        if (!hasError && onSuccess) onSuccess(html);
      })
      .catch(function (err) {
        /* Some other required field on this issue is blank — the endpoint
           refused to save and asked us to resubmit through Redmine's own
           update action so its native full-page validation-error rendering
           takes over (see RfIE.submitEditForm), rather than us trying to
           explain the failure ourselves in a toast for a field that itself
           was actually valid. */
        if (err && err.redirect_to_edit) {
          RfIE.submitEditFormWithFullCf(BASE + '/issues/' + issueId, BASE + '/issues/' + issueId + '/rf_issue', 'issue', fields);
          return;
        }
        cleanup();
        closeEditor(panel);
        var msg = (err && err.errors) ? err.errors.join(', ') : (err.message || 'Unknown error');
        RfIE.toast.error(RfIE.i18n('couldNotSave') + ' ' + msg);
      });
  }

  /* Refresh the History/Notes/Property-changes/Checklist-History tabs.
     That block is rendered once into the initial page and none of this
     plugin's save requests touch it afterwards, so it goes stale until a
     full reload - see #119589.

     Takes a document that has already been fetched by the caller, so no
     extra request is made, and puts back whichever sub-tab was actually
     open rather than defaulting to one.

     Called from both save paths: attribute saves go through
     processResponse, while the description editor posts the form itself
     and never reaches processResponse - leaving description edits missing
     from the tabs until a reload, which is what reopened #119589. */
  function refreshHistorySection(doc) {
    var newHistorySection = doc.querySelector('#history');
    var curHistorySection = document.querySelector('#history');
    if (!newHistorySection || !curHistorySection) return;

    var activeTabLink = curHistorySection.querySelector('.tabs a.selected');
    var activeTabId = activeTabLink ? activeTabLink.id.replace(/^tab-/, '') : 'history';
    curHistorySection.innerHTML = newHistorySection.innerHTML;
    /* "checklist_history" (added by redmineflux_checklist, if installed)
       has its own switcher, rfChecklistShowHistoryTab - the other three
       (history/notes/properties) are core Redmine tabs, handled by core's
       own showIssueHistory. */
    var restoreUrl = window.location.href.split('?')[0] + '?tab=' + activeTabId;
    if (activeTabId === 'checklist_history' && typeof window.rfChecklistShowHistoryTab === 'function') {
      window.rfChecklistShowHistoryTab(activeTabId, restoreUrl);
    } else if (typeof window.showIssueHistory === 'function') {
      window.showIssueHistory(activeTabId, restoreUrl);
    }
  }

  /* Returns true if the response contained a validation error, false on success. */
  function processResponse(html) {
    var parser = new DOMParser();
    var doc    = RfIE.sanitizeDoc(parser.parseFromString(html, 'text/html'));

    /* Error explanation */
    var errEl  = doc.querySelector('#errorExplanation');
    var curErr = document.querySelector('#errorExplanation');
    if (errEl) {
      if (!curErr) {
        var d = document.createElement('div');
        d.id = 'errorExplanation';
        d.innerHTML = errEl.innerHTML;
        var details = document.querySelector('.issue.details');
        if (details) details.insertAdjacentElement('beforebegin', d);
      } else {
        curErr.innerHTML = errEl.innerHTML;
      }
      return true;
    } else if (curErr) {
      curErr.remove();
    }

    /* Refresh attribute display values */
    var newDetails = doc.querySelector('.issue.details');
    var curDetails = document.querySelector('.issue.details');
    if (newDetails && curDetails) {
      /* Update every .attribute in the fresh HTML — using the broad selector (not
         '.attributes .attribute') so full-width custom fields rendered outside
         the .attributes container by render_full_width_custom_fields_rows are
         also refreshed.  Sprint/story-points are excluded here; they are handled
         by the agile section below which preserves their async-fetched panel. */
      newDetails.querySelectorAll('.attribute').forEach(function (newAttr) {
        var attrCls = Array.from(newAttr.classList).filter(function (c) { return c !== 'attribute'; });
        if (!attrCls.length) return;
        var firstCls = attrCls[0];
        if (firstCls === 'sprint' || firstCls === 'story-points') return;
        /* Build a compound selector from ALL non-'attribute' classes so CFs of the
           same format (e.g. string_cf cf_2 vs string_cf cf_9) don't collide.
           Using only attrCls[0] would return the first matching format class and
           overwrite the wrong CF's value. */
        var compoundSel = '.attribute' + attrCls.map(function (c) { return '.' + c; }).join('');
        var curAttr = curDetails.querySelector(compoundSel);
        if (!curAttr) return;
        /* Skip fields currently being edited */
        if (curAttr.querySelector('.value.rf-value-editing')) return;
        var newVal = newAttr.querySelector('.value');
        var curVal = curAttr.querySelector('.value');
        if (newVal && curVal) {
          /* Replace the whole .value content with the server-rendered version and
             clear the decoration flag — decorateAttributes in the setTimeout below
             will re-wrap the value in .rf-show-display and rebuild the editor panel
             from the freshly-updated form element, so the panel never shows stale data. */
          curVal.innerHTML = newVal.innerHTML;
          delete curAttr.dataset.rfDecorated;
        }
      });

      var newSubject = newDetails.querySelector('.subject');
      var curSubject = curDetails.querySelector('.subject');
      if (newSubject && curSubject) {
        var h3 = curSubject.querySelector('h3');
        var newH3 = newSubject.querySelector('h3');
        /* Don't touch the subject while its own editor is open (mirrors the
           ".value.rf-value-editing" skip above for regular attributes). */
        if (h3 && newH3 && !curSubject.classList.contains('rf-value-editing')) {
          /* decorateSubject() appends the pencil icon (.rf-edit-icon) as a child
             of this exact h3 element (see decorateSubject, `h3.appendChild(icon)`)
             and binds its click listener directly to that DOM node. Blindly doing
             `h3.textContent = ...` here — which every OTHER save on the page
             routes through, not just subject saves — replaces all of h3's
             children with a single text node, silently discarding the icon node
             the click listener is attached to. The icon disappears from the DOM
             and nothing is left to click, so the Subject editor can no longer be
             opened until a full page refresh re-runs decorateSubject(). Preserve
             the existing icon node across the text swap by detaching it first and
             re-appending it afterward — same pattern decorateSubject's own Enter
             handler already uses (`h3.appendChild(icon)` after `h3.textContent =`)
             for its own optimistic-update path. */
          var existingIcon = h3.querySelector('.rf-edit-icon');
          h3.textContent = newH3.textContent;
          if (existingIcon) h3.appendChild(existingIcon);
        }
      }

      /* Refresh agile plugin fields (sprint, story-points) — rendered by
         view_issues_show_details_bottom hook, outside the .attributes section */
      ['sprint', 'story-points'].forEach(function (cls) {
        var newAttr = newDetails.querySelector('.attribute.' + cls);
        var curAttr = document.querySelector('.attribute.' + cls);
        if (!newAttr || !curAttr) return;
        var newVal = newAttr.querySelector('.value');
        var curVal = curAttr.querySelector('.value');
        if (!newVal || !curVal) return;
        var displayWrap = curVal.querySelector('.rf-show-display');
        if (displayWrap) displayWrap.innerHTML = newVal.innerHTML;
      });

      /* Refresh the checklist plugin's section (redmineflux_checklist) —
         also rendered by a view hook (view_issues_show_description_bottom),
         outside .issue.details, same as sprint/story-points above. Without
         this, its enabled/disabled state (computed from the issue's status
         at render time — see _checklist.html.erb) goes stale after any
         status change made through this inline editor: closing the issue
         leaves the checklist checkboxes clickable, and reopening it leaves
         them stuck disabled, until a full page reload re-renders them. */
      var newChecklist = doc.querySelector('#checklist-hook-section');
      var curChecklist = document.querySelector('#checklist-hook-section');
      if (newChecklist && curChecklist) curChecklist.innerHTML = newChecklist.innerHTML;
    }

    refreshHistorySection(doc);

    /* Update issue form (lock_version etc.) */
    var newForm = doc.querySelector('form#issue-form');
    var curForm = document.querySelector('form#issue-form');
    if (newForm && curForm) curForm.innerHTML = newForm.innerHTML;

    syncSubjectEditor();

    /* Update lock version */
    var newLv = doc.querySelector('#issue_lock_version');
    var curLv = document.querySelector('#issue_lock_version');
    if (newLv && curLv) curLv.value = newLv.value;

    /* Update CSRF token */
    var newToken = doc.querySelector('input[name="authenticity_token"]');
    if (newToken) RfIE.csrf.update(newToken.value);

    /* Re-decorate any attributes that have fresh (un-decorated) HTML.
       The data-rf-decorated guard ensures already-decorated attrs are untouched.
       Also re-run the agile decorators so sprint / story-points get their pencil
       back when their containing section was replaced by processResponse. */
    setTimeout(function () {
      var det = document.querySelector('.issue.details');
      if (!det) return;
      decorateAttributes(det);
      decorateSprint(det);
      decorateStoryPoints(det);
    }, 50);
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
