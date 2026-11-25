/**
 * RF Inline Editor — Core Module
 * Namespace: window.RfIE
 * Provides: config, API client, toast notifications, searchable select,
 *           date utilities, DOM helpers.
 */
(function (window, document) {
  'use strict';

  /* ── Namespace ──────────────────────────────────────────────── */
  window.RfIE = window.RfIE || {};
  var RfIE = window.RfIE;

  /* ── i18n lookup ────────────────────────────────────────────────
     Reads a translated string set by _rf_header_assets.html.erb on
     window.RfIE.config.i18n. Falls back to the one hardcoded English
     default per key below if config.i18n is missing/not-yet-populated (so
     a missing translation never breaks the UI, and never throws) — this is
     the single place these English defaults live; no consumer module
     should ever spell one out again at its own call site.

     'none' has no entry here on purpose: it sources from Redmine core's own
     l(:label_none), the same key core dropdowns already render correctly —
     not a plugin-composed string, so there is no plugin-owned English
     literal to fall back to (an English "none" would itself be a hardcoded
     literal, defeating the point). If window.RfIE.config.i18n is ever
     entirely absent that one option renders blank rather than "None" —
     an acceptable trade for never having a real hardcoded string sitting
     unused in this file. */
  var RF_I18N_DEFAULTS = {
    search:                  'Search…',
    saving:                  'Saving…',
    couldNotSave:            'Could not save:',
    savedSuccessfully:       'Saved successfully.',
    save:                    'Save',
    cancel:                  'Cancel',
    subjectBlank:            'Subject cannot be blank.',
    staleObjectConflict:     'the issue may have been modified by another user. Please reload the page and try again.',
    unknownError:            'Unknown error',
    genericSaveError:        'Could not save. Please try again.',
    unexpectedError:         'An unexpected error occurred. Please try again.',
    noPermissionProject:     'You do not have permission to edit this project.',
    noPermissionIssue:       'You do not have permission to edit this issue.',
    projectNotFound:         'Project not found. Please refresh the page.',
    issueNotFound:           'Issue not found. Please refresh the page.',
    valueNotSavedProject:    'The value could not be saved. Please check and try again.',
    changeNotSaved:          'The change could not be saved. Please check the value and try again.',
    serverError:             'A server error occurred. Please try again later.',
    connectionError:         'Connection error. Please check your network and try again.',
    projectNameUpdated:      'Project name updated.',
    projectIdNotFound:       'Project ID not found.',
    changesSavedSuccessfully: 'Changes saved successfully.'
  };
  function rfI18n(key) {
    var dict = RfIE.config && RfIE.config.i18n;
    return (dict && dict[key]) || RF_I18N_DEFAULTS[key] || '';
  }
  /* Exposed publicly so every consumer module (issue_show, issue_table,
     project_table, project_card) can look up a translated string the same
     safe way, instead of indexing window.RfIE.config.i18n.<key> directly —
     that throws if config.i18n is ever missing/not-yet-populated, which
     silently aborts whatever save/error handler was reading it. */
  RfIE.i18n = rfI18n;

  /* ── SVG icon strings ───────────────────────────────────────── */
  RfIE.icons = {
    pencil:
      '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor">' +
      '<path d="M13.488 2.513a1.75 1.75 0 0 0-2.475 0L6.75 6.774a2.75 2.75 0 0 0-.596.892l-.747 ' +
      '2.037a.75.75 0 0 0 .965.965l2.037-.747a2.75 2.75 0 0 0 .892-.596l4.261-4.263a1.75 1.75 0 ' +
      '0 0 0-2.474Z"/>' +
      '<path d="M4.75 3.5c-.69 0-1.25.56-1.25 1.25v6.5c0 .69.56 1.25 1.25 1.25h6.5c.69 0 ' +
      '1.25-.56 1.25-1.25V8.75a.75.75 0 0 1 1.5 0v2.5A2.75 2.75 0 0 1 11.25 14h-6.5A2.75 ' +
      '2.75 0 0 1 2 11.25v-6.5A2.75 2.75 0 0 1 4.75 2h2.5a.75.75 0 0 1 0 1.5h-2.5Z"/>' +
      '</svg>',

    check:
      '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">' +
      '<path fill-rule="evenodd" d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06' +
      ' 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" fill="currentColor"/></svg>',

    x:
      '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">' +
      '<path fill-rule="evenodd" d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 1' +
      '11.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-' +
      '1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" fill="currentColor"/></svg>',

    chevronDown:
      '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">' +
      '<path fill-rule="evenodd" d="M4.427 7.427l3.396 3.396a.25.25 0 00.354 0l3.396-3.396A' +
      '.25.25 0 0011.396 7H4.604a.25.25 0 00-.177.427z" fill="currentColor"/></svg>',

    alert:
      '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">' +
      '<path fill-rule="evenodd" d="M8.22 1.754a.25.25 0 00-.44 0L1.698 13.132a.25.25 0 00.22' +
      '.368h12.164a.25.25 0 00.22-.368L8.22 1.754zm-1.763-.707c.659-1.234 2.427-1.234 3.086 0' +
      'l6.082 11.378A1.75 1.75 0 0114.082 15H1.918a1.75 1.75 0 01-1.543-2.575L6.457 1.047zM9 ' +
      '11a1 1 0 11-2 0 1 1 0 012 0zm-.25-5.25a.75.75 0 00-1.5 0v2.5a.75.75 0 001.5 0v-2.5z" fill="currentColor"/></svg>',

    info:
      '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">' +
      '<path fill-rule="evenodd" d="M8 1.5a6.5 6.5 0 100 13A6.5 6.5 0 008 1.5zM0 8a8 8 0 111' +
      '6 0A8 8 0 010 8zm6.5-.25A.75.75 0 017.25 7h1a.75.75 0 01.75.75v2.75h.25a.75.75 0 010 ' +
      '1.5h-2a.75.75 0 010-1.5h.25v-2h-.25a.75.75 0 01-.75-.75zM8 6a1 1 0 100-2 1 1 0 000 2z" fill="currentColor"/></svg>',

    success:
      '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">' +
      '<path fill-rule="evenodd" d="M8 1.5a6.5 6.5 0 100 13A6.5 6.5 0 008 1.5zM0 8a8 8 0 111' +
      '6 0A8 8 0 010 8zm11.78-1.72a.75.75 0 00-1.06-1.06L7 8.94 5.28 7.22a.75.75 0 00-1.06 1' +
      '.06l2.25 2.25a.75.75 0 001.06 0l4.25-4.25z" fill="currentColor"/></svg>'
  };

  /* ── Config: merge server-injected values (set in <head>) with defaults.
     The _rf_header_assets partial runs in <head> and sets window.RfIE.config
     BEFORE this file loads. We must NOT overwrite those values. ─────────── */
  var _srv = window.RfIE.config || {};
  RfIE.config = {
    /* Translated strings set by _rf_header_assets.html.erb (window.RfIE.config.i18n).
       Same class of bug as issueEditable below: absent from this whitelist, i18n
       was silently dropped every time this file rebuilt RfIE.config, even though
       the header partial set it correctly — every RfIE.i18n() lookup then fell
       through to its English default regardless of the active locale. */
    i18n:             _srv.i18n             || {},
    canEditIssues:    _srv.canEditIssues    !== undefined ? _srv.canEditIssues    : false,
    canEditOwnIssues: _srv.canEditOwnIssues !== undefined ? _srv.canEditOwnIssues : false,
    canEditProjects:  _srv.canEditProjects  !== undefined ? _srv.canEditProjects  : false,
    dateFormat:      _srv.dateFormat      || 'MM/DD/YYYY',
    textFormat:      _srv.textFormat      || 'textile',
    /* An id is used to build URLs: accept digits only. */
    issueId:         /^\d+$/.test(String(_srv.issueId || '')) ? String(_srv.issueId) : null,
    /* Whether THIS SPECIFIC issue (when @issue is present server-side) is
       editable by the current user — true either via :edit_issues or via
       :edit_own_issues + authorship (Issue#attributes_editable?). Absent
       from this whitelist, this key — like canEditOwnIssues above — was
       silently dropped every time this file rebuilt RfIE.config, even
       though the header partial correctly set it; rf_inline_editor_issue_show.js's
       permission guard read undefined and always failed closed. */
    issueEditable:   _srv.issueEditable    !== undefined ? _srv.issueEditable    : false,
    ckEditorOptions: _srv.ckEditorOptions || null,
    /* Deliberately absent - saves go out on the browser session plus the CSRF
       token, which is also why CSRF is now actually enforced on them. */
    parentIssueDatesDerived:     _srv.parentIssueDatesDerived     === true,
    parentIssueDoneRatioDerived: _srv.parentIssueDoneRatioDerived === true,
    parentIssuePriorityDerived:  _srv.parentIssuePriorityDerived  === true,
    /* The CSRF token goes out with every request built on this address, so it is never taken from a
       <base> tag (one injected into the page would point it at another site). */
    baseUrl:         _srv.baseUrl || window.location.origin
  };

  /* ── Links built from stored text ────────────────────────────────
     A homepage or a Link custom field is text the user typed. Used as a href it can carry a
     "javascript:" address that runs when someone clicks it. Only http, https, ftp, mailto and relative
     addresses are let through; anything else gives '' so the caller shows plain text. Characters a
     browser ignores inside a scheme (tab, new line, spaces) are removed before the check. */
  RfIE.safeUrl = function (value) {
    var s = String(value == null ? '' : value).trim();
    if (!s) return '';
    var compact = s.replace(/[\u0000-\u0020\u007f-\u009f]+/g, '');
    if (/^(https?|ftp|mailto):/i.test(compact)) return s;
    if (/^[a-z][a-z0-9+.\-]*:/i.test(compact)) return '';
    return s;
  };

  /* ── Server HTML that is copied into the live page ───────────────
     After a save the editor re-reads the issue page and copies parts of it (description, history, checklist
     block...) into the open page with innerHTML. Anything on that page that fires by itself - an <img onerror>,
     an onload, an autofocus handler, a javascript: address - would therefore run again after every inline save,
     not only on a page load. Remove those from the parsed copy first. Click handlers stay: Redmine's own history
     tabs and copy buttons use them, and they need a person to click. */
  RfIE.sanitizeDoc = function (doc) {
    if (!doc || !doc.querySelectorAll) return doc;
    var urlAttrs = { href: 1, src: 1, action: 1, formaction: 1, 'xlink:href': 1, data: 1 };
    Array.prototype.forEach.call(doc.querySelectorAll('*'), function (el) {
      Array.prototype.slice.call(el.attributes).forEach(function (attr) {
        var name = attr.name.toLowerCase();
        if (name.indexOf('on') === 0 && name !== 'onclick') {
          el.removeAttribute(attr.name);
        } else if (urlAttrs[name] && /^javascript:/i.test(String(attr.value).replace(/[\u0000-\u0020\u007f-\u009f]+/g, ''))) {
          el.removeAttribute(attr.name);
        }
      });
    });
    return doc;
  };

  /* <a> markup for a stored link, escaped with the caller's own escape function; plain text when the
     address is not allowed. */
  RfIE.linkHtml = function (value, escape) {
    var url = RfIE.safeUrl(value);
    return url
      ? '<a href="' + escape(url) + '" target="_blank" rel="noopener noreferrer">' + escape(String(value)) + '</a>'
      : escape(String(value));
  };

  /* ── CSRF token helpers ──────────────────────────────────────── */
  RfIE.csrf = {
    get: function () {
      var meta = document.querySelector('meta[name="csrf-token"]');
      return meta ? meta.getAttribute('content') : '';
    },
    update: function (token) {
      var meta = document.querySelector('meta[name="csrf-token"]');
      if (meta) meta.setAttribute('content', token);
      document.querySelectorAll('input[name="authenticity_token"]').forEach(function (el) {
        el.value = token;
      });
    }
  };

  /* ── API Client ──────────────────────────────────────────────── */
  RfIE.api = {
    _headers: function (json) {
      var h = { 'X-CSRF-Token': RfIE.csrf.get() };
      if (json) h['Content-Type'] = 'application/json';

      return h;
    },

    /** GET JSON from a URL. Returns a Promise<object>. */
    get: function (url) {
      return fetch(url, {
        method:  'GET',
        headers: this._headers(false),
        credentials: 'same-origin'
      }).then(function (r) {
        if (!r.ok) return r.json().then(function (e) { throw e; }).catch(function () { throw new Error('HTTP ' + r.status); });
        return r.json();
      });
    },

    /** PUT JSON data. Returns a Promise resolving to the parsed body or {}. */
    put: function (url, body) {
      return fetch(url, {
        method:  'PUT',
        headers: this._headers(true),
        body:    JSON.stringify(body),
        credentials: 'same-origin'
      }).then(function (r) {
        if (r.status === 422) {
          return r.json().then(function (e) { throw e; });
        }
        if (!r.ok) {
          /* Keep the server's own wording when it sent some. Throwing only the
             status code meant a refusal explaining exactly which field could not
             be changed was replaced by a generic "you do not have permission to
             edit this issue", which is both vaguer and not actually true - the
             user can edit the issue, just not that one field right now (#121113).
             422 keeps its own branch above: those bodies carry redirect_to_edit
             rather than errors, and callers act on it. */
          return r.json().catch(function () { return null; }).then(function (body) {
            if (body && body.errors && body.errors.length) throw body;
            throw new Error('HTTP ' + r.status);
          });
        }
        return r.status === 204 ? {} : r.json().catch(function () { return {}; });
      });
    },

    /**
     * PATCH an issue/project via standard Redmine form POST (redirect:manual pattern).
     * Returns a Promise<string> with the response HTML (for full page refresh logic).
     */
    patchForm: function (url, fields) {
      var token = RfIE.csrf.get();
      var fd = new FormData();
      fd.append('_method', 'patch');
      fd.append('authenticity_token', token);
      Object.keys(fields).forEach(function (k) {
        var v = fields[k];
        if (Array.isArray(v)) {
          v.forEach(function (item) { fd.append(k + '[]', item); });
        } else {
          fd.append(k, v == null ? '' : v);
        }
      });
      return fetch(url, {
        method:   'POST',
        redirect: 'manual',
        body:     fd,
        credentials: 'same-origin'
      }).then(function (r) {
        if (r.type === 'opaqueredirect') {
          /* cache: 'reload' forces a fresh response from the server, bypassing
             any browser-cached copy of the issue show page. Without this, the
             follow-up GET can return the old page and processResponse shows
             stale values until the user manually refreshes. */
          return fetch(url, { credentials: 'same-origin', cache: 'reload' }).then(function (r2) { return r2.text(); });
        }
        return r.text();
      });
    }
  };

  /**
   * Submit a REAL <form> POST (full page navigation, not fetch/XHR) carrying
   * the same single field change the inline editor just attempted. Used when
   * that change is blocked because some OTHER required field on the record
   * is blank: rather than a custom toast explaining that, this resubmits the
   * one field through Redmine's own update action so its normal validation
   * failure path runs — Issue/ProjectsController#update re-renders the
   * edit/settings template with @issue.errors (or @project.errors) populated,
   * which is exactly Redmine core's native "N errors prohibited this ... from
   * being saved" box with the offending fields listed and highlighted. A
   * fetch-based request can't produce this — only a genuine full-page form
   * submission causes the browser to render that response as the live page.
   */
  RfIE.submitEditForm = function (url, fields) {
    var form = document.createElement('form');
    form.method = 'POST';
    form.action = url;
    form.style.display = 'none';

    function addHidden(name, value) {
      var inp = document.createElement('input');
      inp.type  = 'hidden';
      inp.name  = name;
      inp.value = value == null ? '' : value;
      form.appendChild(inp);
    }

    addHidden('_method', 'patch');
    addHidden('authenticity_token', RfIE.csrf.get());
    Object.keys(fields).forEach(function (k) {
      var v = fields[k];
      if (Array.isArray(v)) {
        v.forEach(function (item) { addHidden(k + '[]', item); });
      } else {
        addHidden(k, v);
      }
    });

    document.body.appendChild(form);
    form.submit();
  };

  /**
   * Like RfIE.submitEditForm, but guarantees Redmine's own custom-field
   * requiredness validation actually runs. acts_as_customizable
   * (lib/plugins/acts_as_customizable/lib/acts_as_customizable.rb) only
   * validates custom fields when custom_field_values_changed? is true, and
   * that flag is only set when the request's params include a
   * custom_field_values key AT ALL — so resubmitting just the one native
   * attribute the user actually edited (e.g. issue[priority_id], with no
   * custom_field_values key present) would make Issue/Project#update
   * silently skip checking every custom field, including the very blank
   * required one we're trying to surface. Fetching the record's current
   * custom field values first and including all of them (unchanged, alongside
   * whatever the user actually edited) makes the resubmission touch
   * custom_field_values for real, exactly like submitting the full Edit form
   * would.
   */
  RfIE.submitEditFormWithFullCf = function (url, jsonUrl, paramName, changedFields) {
    RfIE.api.get(jsonUrl).then(function (data) {
      var record = data[paramName];
      var merged = {};
      var changedKeys = Object.keys(changedFields);
      changedKeys.forEach(function (k) { merged[k] = changedFields[k]; });
      if (record && record.custom_fields) {
        record.custom_fields.forEach(function (cf) {
          var prefix = paramName + '[custom_field_values][' + cf.id + ']';
          /* changedFields may reference this CF under several different key
             shapes depending on which editor built it — a plain scalar
             (prefix exactly, e.g. "issue[custom_field_values][5]"), an
             indexed multi-value entry (prefix + "[0]", "[1]", …), or an
             array-style entry (prefix + "[]"). Checking for the exact
             `prefix` key alone missed the indexed/array forms, so this CF's
             "unchanged, keep it as-is" fallback got added ALONGSIDE
             changedFields' own entries instead of being skipped — Rack then
             saw the same custom_field_values[cfId] key used as both a Hash
             (from the "[0]" indexed form) and an Array (from the "[]" form)
             in the same request body, which raises
             Rack::QueryParser::ParameterTypeError while parsing it for the
             _method=patch override — an error Rack::MethodOverride swallows
             silently, leaving the request as a plain POST that no route
             matches, instead of the intended PATCH to Issue/ProjectsController
             #update. */
          var alreadyTouched = changedKeys.some(function (k) {
            return k === prefix || k.indexOf(prefix + '[') === 0;
          });
          if (!alreadyTouched) merged[prefix] = (cf.value == null ? '' : cf.value);
        });
      }
      RfIE.submitEditForm(url, merged);
    }).catch(function () {
      /* Couldn't fetch current values — still resubmit with what we have
         rather than leaving the user stuck; native-attribute validation
         (due dates, category, etc.) still runs either way. */
      RfIE.submitEditForm(url, changedFields);
    });
  };

  /* ── Date Utilities ─────────────────────────────────────────── */
  RfIE.dateUtils = {
    /**
     * Convert a display-format date string (e.g. "12/31/2025") → ISO "2025-12-31".
     * Falls back gracefully on unexpected input.
     */
    toISO: function (displayDate, fmt) {
      fmt = fmt || RfIE.config.dateFormat || 'MM/DD/YYYY';
      if (!displayDate || !displayDate.trim()) return '';
      var s = displayDate.trim();
      var sep = fmt.replace(/[A-Z]/g, '').charAt(0) || '/';
      var parts = s.split(sep);
      if (parts.length < 3) return s; // already ISO or unrecognised
      var fParts = fmt.split(sep);
      var map = {};
      fParts.forEach(function (p, i) { map[p] = parts[i] || ''; });
      var y = map['YYYY'] || map['YY'] || '';
      var m = map['MM'] || '';
      var d = map['DD'] || '';
      if (!y || !m || !d) return s;
      if (y.length === 2) y = '20' + y;
      return y + '-' + m.padStart(2, '0') + '-' + d.padStart(2, '0');
    },

    /**
     * Convert ISO "2025-12-31" → display format (e.g. "12/31/2025").
     */
    toDisplay: function (isoDate, fmt) {
      fmt = fmt || RfIE.config.dateFormat || 'MM/DD/YYYY';
      if (!isoDate || !isoDate.trim()) return '';
      var parts = isoDate.trim().split('-');
      if (parts.length < 3) return isoDate;
      var y = parts[0], m = parts[1], d = parts[2];
      var sep = fmt.replace(/[A-Z]/g, '').charAt(0) || '/';
      return fmt.split(sep).map(function (p) {
        if (p === 'YYYY') return y;
        if (p === 'YY')   return y.slice(-2);
        if (p === 'MM')   return m;
        if (p === 'DD')   return d;
        return p;
      }).join(sep);
    }
  };

  /* -- Date input save timing ---------------------------------------
     A native <input type="date"> fires `change` the moment its three
     segments form a complete date - which keeps happening while the year
     is still being typed (2 -> 0002, 20 -> 0020, 202 -> 0202, 2026).
     Saving on each of those wrote a half-typed year to the issue, so
     "12.03.2026" landed as "12.03.0026" and had to be corrected by hand;
     typing a date was effectively unusable and only the calendar picker
     could be trusted (#120919).

     Every date field - the issue's own start/due dates and any
     date-format custom field - saves through here, so they all behave
     the same way:
       - picked from the calendar: saved straight away, as before
       - typed: nothing is saved while typing, however long it takes -
         the value is saved when the field is left or Enter is pressed
       - Escape: the typed value is dropped

     Deliberately no save-after-a-pause timer: any pause length long
     enough to feel responsive is also short enough for a slow typist to
     hit mid-year, which would write the same half-typed date all over
     again. Leaving the field is the only unambiguous "I am done". */
  RfIE.bindDateInput = function (inp, commit) {
    var typedValueWaiting = false;
    var lastKeyAt = 0;

    function cancel() { typedValueWaiting = false; }
    function flush() {
      if (!typedValueWaiting) return;
      typedValueWaiting = false;
      commit(inp.value);
    }

    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter')  { e.preventDefault(); flush(); return; }
      if (e.key === 'Escape') { cancel(); return; }
      lastKeyAt = Date.now();
    });

    inp.addEventListener('change', function () {
      /* No keystroke just before this change means it came from the
         calendar picker (or a paste) - that value is already complete,
         so there is nothing to wait for. */
      if (Date.now() - lastKeyAt > 500) { commit(inp.value); return; }
      typedValueWaiting = true;
    });

    inp.addEventListener('blur', function () { flush(); });

    return { cancel: cancel, flush: flush };
  };


  /* ── DOM Utilities ──────────────────────────────────────────── */
  RfIE.dom = {
    /** Create a pencil edit icon element. */
    editIcon: function () {
      var el = document.createElement('span');
      el.className = 'rf-edit-icon';
      el.setAttribute('aria-label', 'Edit');
      el.setAttribute('role', 'button');
      el.setAttribute('tabindex', '0');
      el.innerHTML = RfIE.icons.pencil;
      return el;
    },

    /** Create a spinner element. */
    spinner: function () {
      var el = document.createElement('span');
      el.className = 'rf-spinner';
      el.setAttribute('aria-label', rfI18n('saving'));
      return el;
    }
  };

  /* ── Toast Notifications ────────────────────────────────────── */
  RfIE.toast = (function () {
    var _container = null;

    function container() {
      if (!_container) {
        _container = document.createElement('div');
        _container.className = 'rf-toast-container';
        _container.setAttribute('aria-live', 'polite');
        _container.setAttribute('aria-atomic', 'false');
        document.body.appendChild(_container);
      }
      return _container;
    }

    var _typeIcon = {
      success: RfIE.icons.success,
      error:   RfIE.icons.alert,
      warning: RfIE.icons.alert,
      info:    RfIE.icons.info
    };

    function show(msg, type, duration) {
      type     = type     || 'info';
      duration = duration || 3500;

      var toast = document.createElement('div');
      toast.className = 'rf-toast rf-toast--' + type;
      toast.setAttribute('role', 'alert');
      toast.innerHTML =
        '<span class="rf-toast__icon">' + (_typeIcon[type] || _typeIcon.info) + '</span>' +
        '<span class="rf-toast__message"></span>' +
        '<span class="rf-toast__close" aria-label="Dismiss">' + RfIE.icons.x + '</span>' +
        '<div class="rf-toast__bar"></div>';
      /* msg may contain server-supplied validation text (SEC-001) — set via
         textContent rather than concatenated into the innerHTML string above,
         so it can never be interpreted as markup. */
      toast.querySelector('.rf-toast__message').textContent = msg;

      var bar = toast.querySelector('.rf-toast__bar');
      container().appendChild(toast);

      // Animate bar shrink
      bar.style.transition = 'transform ' + duration + 'ms linear';
      bar.style.transformOrigin = 'left center';

      requestAnimationFrame(function () {
        toast.classList.add('rf-toast--in');
        requestAnimationFrame(function () {
          bar.style.transform = 'scaleX(0)';
        });
      });

      var timer = setTimeout(function () { dismiss(toast); }, duration);
      toast.querySelector('.rf-toast__close').addEventListener('click', function () {
        clearTimeout(timer);
        dismiss(toast);
      });
    }

    function dismiss(toast) {
      toast.classList.remove('rf-toast--in');
      toast.classList.add('rf-toast--out');
      setTimeout(function () {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 280);
    }

    return {
      success: function (msg) { show(msg, 'success', 3000); },
      error:   function (msg) { show(msg, 'error',   5000); },
      warning: function (msg) { show(msg, 'warning', 4000); },
      info:    function (msg) { show(msg, 'info',    3000); }
    };
  }());

  /* ── Portal dropdown positioning ────────────────────────────── */
  /**
   * Position a `position: fixed` dropdown/list against an anchor element,
   * flipping above and clamping horizontally when it would overflow the
   * viewport. Call once the list is appended to document.body. Shared by
   * RfIE.SearchableSelect and RfIE.MultiSelect so both portal dropdowns
   * escape clipping by scrollable ancestors (e.g. the issue list table's
   * div.autoscroll) the same way.
   */
  RfIE.positionDropdown = function (anchorEl, listEl, maxHeight) {
    maxHeight = maxHeight || 220; /* keep in sync with each dropdown's CSS max-height */
    var rect = anchorEl.getBoundingClientRect();
    var spaceBelow = window.innerHeight - rect.bottom;
    var openUpward = spaceBelow < maxHeight && rect.top > spaceBelow;

    listEl.style.left  = rect.left + 'px';
    listEl.style.width = rect.width + 'px';
    listEl.style.top   = openUpward ? 'auto' : (rect.bottom + 3) + 'px';
    listEl.style.bottom = openUpward ? (window.innerHeight - rect.top + 3) + 'px' : 'auto';

    /* Re-measure after layout to clamp horizontally within the viewport. */
    var listRect = listEl.getBoundingClientRect();
    if (listRect.right > window.innerWidth) {
      listEl.style.left = Math.max(0, window.innerWidth - listRect.width) + 'px';
    }
  };

  /* ── Searchable Select Component ────────────────────────────── */
  /**
   * Creates a searchable select widget.
   *
   * @param {Array}  options   [{id, name}] — the option list
   * @param {Object} cfg
   *   cfg.selectedId    — pre-selected value
   *   cfg.placeholder   — input placeholder text
   *   cfg.allowBlank    — include an empty/none option
   *   cfg.blankLabel    — label for blank option (default: Redmine core's own l(:label_none))
   *   cfg.minWidth      — CSS min-width value (e.g. "160px")
   *   cfg.onSelect      — function(id, name) called on selection
   *
   * @returns {HTMLElement} wrapper element with .getValue(), .getName(), .setValue()
   */
  RfIE.SearchableSelect = function (options, cfg) {
    cfg = cfg || {};
    options = options || [];

    var _selectedId   = cfg.selectedId != null ? String(cfg.selectedId) : null;
    var _selectedName = '';
    var _focusIdx     = -1;
    var _open         = false;

    /* Find current name from options */
    options.forEach(function (o) {
      if (String(o.id) === _selectedId) _selectedName = o.name;
    });

    /* Build DOM */
    var wrapper = document.createElement('div');
    wrapper.className = 'rf-ss';
    if (cfg.minWidth) wrapper.style.minWidth = cfg.minWidth;

    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'rf-ss__input';
    input.value = _selectedName;
    input.placeholder = cfg.placeholder || rfI18n('search');
    input.autocomplete = 'off';
    input.spellcheck = false;

    var caret = document.createElement('span');
    caret.className = 'rf-ss__caret';
    caret.innerHTML = RfIE.icons.chevronDown;

    var list = document.createElement('ul');
    list.className = 'rf-ss__dropdown';
    list.setAttribute('role', 'listbox');

    wrapper.appendChild(input);
    wrapper.appendChild(caret);
    /* The dropdown list is portaled to document.body — NOT appended into
       wrapper — while open, so it isn't clipped by scrollable/overflow
       ancestors (e.g. the issue list table's div.autoscroll clips
       absolutely-positioned content, cutting the dropdown short on rows near
       the table's bottom or in the last column). It's attached in openList()
       and detached again in closeList(), rather than left permanently
       parked in body, since a fresh SearchableSelect is built every time a
       cell is edited — leaving each instance's list behind would leak one
       orphaned <ul> into body per edit for the lifetime of the page. */

    /* ── Build / filter option list ── */
    function buildList(filter) {
      list.innerHTML = '';
      _focusIdx = -1;
      var pool = [];
      if (cfg.allowBlank) pool.push({ id: '', name: cfg.blankLabel || rfI18n('none') });
      pool = pool.concat(options);

      var lf = filter ? filter.toLowerCase() : '';
      var visible = lf
        ? pool.filter(function (o) { return o.name.toLowerCase().indexOf(lf) >= 0; })
        : pool;

      if (!visible.length) {
        var empty = document.createElement('li');
        empty.className = 'rf-ss__option rf-ss__option--empty';
        empty.textContent = 'No results';
        list.appendChild(empty);
        return;
      }

      visible.forEach(function (opt) {
        var li = document.createElement('li');
        li.className = 'rf-ss__option';
        li.setAttribute('role', 'option');
        li.setAttribute('data-rf-id', opt.id);
        li.setAttribute('data-rf-name', opt.name);
        if (String(opt.id) === _selectedId) {
          li.classList.add('rf-ss__option--selected');
          li.setAttribute('aria-selected', 'true');
        }
        li.textContent = opt.name;

        li.addEventListener('mousedown', function (e) {
          e.preventDefault();
          commit(opt.id, opt.name);
        });
        list.appendChild(li);
      });
    }

    function commit(id, name) {
      _selectedId   = id != null ? String(id) : '';
      _selectedName = name || '';
      input.value   = _selectedName;
      closeList();
      if (cfg.onSelect) cfg.onSelect(_selectedId, _selectedName);
    }

    function reposition() { if (_open) RfIE.positionDropdown(input, list); }

    function openList() {
      /* wrapper (and input) may exist but never have been inserted into the
         page — e.g. the async data fetch that builds this SearchableSelect
         resolved after the cell edit was already cancelled, but callers
         still unconditionally call ss.focusInput() right after render.
         Skip opening the portaled list in that case: getBoundingClientRect()
         on a detached input returns all-zero, which would otherwise place a
         visible dropdown at the page's top-left corner. */
      if (!document.body.contains(input)) return;
      buildList(input.value !== _selectedName ? input.value : '');
      if (!list.parentNode) document.body.appendChild(list);
      list.classList.add('rf-ss__dropdown--open');
      _open = true;
      RfIE.positionDropdown(input, list);
      window.addEventListener('scroll', reposition, true);
      window.addEventListener('resize', reposition);
    }

    function closeList() {
      list.classList.remove('rf-ss__dropdown--open');
      _open = false;
      _focusIdx = -1;
      if (input.value !== _selectedName) input.value = _selectedName;
      if (list.parentNode) list.parentNode.removeChild(list);
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    }

    function moveFocus(delta) {
      var items = list.querySelectorAll('.rf-ss__option:not(.rf-ss__option--empty)');
      if (!items.length) return;
      _focusIdx = Math.max(0, Math.min(_focusIdx + delta, items.length - 1));
      items.forEach(function (li, i) {
        li.classList.toggle('rf-ss__option--focused', i === _focusIdx);
      });
      if (items[_focusIdx]) items[_focusIdx].scrollIntoView({ block: 'nearest' });
    }

    /* ── Events ── */
    input.addEventListener('focus', function () {
      input.select();
      openList();
    });

    input.addEventListener('input', function () {
      openList();
    });

    input.addEventListener('blur', function () {
      setTimeout(closeList, 160);
    });

    input.addEventListener('keydown', function (e) {
      if (!_open && (e.key === 'ArrowDown' || e.key === 'Enter')) {
        e.preventDefault();
        openList();
        return;
      }
      if (e.key === 'ArrowDown')  { e.preventDefault(); moveFocus(1); }
      if (e.key === 'ArrowUp')    { e.preventDefault(); moveFocus(-1); }
      if (e.key === 'Escape')     { closeList(); }
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        var items = list.querySelectorAll('.rf-ss__option:not(.rf-ss__option--empty)');
        if (_focusIdx >= 0 && items[_focusIdx]) {
          commit(items[_focusIdx].dataset.rfId, items[_focusIdx].dataset.rfName);
        }
      }
      if (e.key === 'Tab') { closeList(); }
    });

    /* ── Public API ── */
    wrapper.getValue  = function ()       { return _selectedId; };
    wrapper.getName   = function ()       { return _selectedName; };
    wrapper.setValue  = function (id, name) { commit(id, name || ''); };
    wrapper.focusInput = function ()      { input.focus(); };

    return wrapper;
  };

  /* ── Multi-Select Component ─────────────────────────────────── */
  /**
   * Creates a tag-style multi-select widget: removable chips for selected
   * values plus a searchable checkbox dropdown for picking more — used for
   * multi-select custom fields in place of a bare native <select multiple>.
   *
   * @param {Array}  options  [{id, name}] — the option list
   * @param {Object} cfg
   *   cfg.selectedIds  — pre-selected values (array of ids)
   *   cfg.placeholder  — input placeholder text (shown when nothing is selected)
   *   cfg.minWidth     — CSS min-width value (e.g. "160px")
   *
   * @returns {HTMLElement} wrapper with .getValues() -> [ids], .getNames() -> [names]
   */
  RfIE.MultiSelect = function (options, cfg) {
    cfg = cfg || {};
    options = options || [];

    var _selected  = {}; /* id (string) -> name */
    var _open      = false;
    var _focusIdx  = -1;

    (cfg.selectedIds || []).forEach(function (id) {
      var opt = options.filter(function (o) { return String(o.id) === String(id); })[0];
      if (opt) _selected[String(opt.id)] = opt.name;
    });

    /* Build DOM */
    var wrapper = document.createElement('div');
    wrapper.className = 'rf-ms';
    if (cfg.minWidth) wrapper.style.minWidth = cfg.minWidth;

    var control = document.createElement('div');
    control.className = 'rf-ms__control';

    var chipsWrap = document.createElement('div');
    chipsWrap.className = 'rf-ms__chips';

    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'rf-ms__input';
    input.autocomplete = 'off';
    input.spellcheck = false;

    var caret = document.createElement('span');
    caret.className = 'rf-ms__caret';
    caret.innerHTML = RfIE.icons.chevronDown;

    control.appendChild(chipsWrap);
    control.appendChild(input);
    wrapper.appendChild(control);
    wrapper.appendChild(caret);

    /* Portaled to document.body while open — same reasoning as
       RfIE.SearchableSelect's dropdown: avoids clipping by scrollable
       ancestors (e.g. the issue list table's div.autoscroll), and is
       attached/detached in openList()/closeList() rather than left parked
       in body to avoid leaking one <ul> per edit session. */
    var list = document.createElement('ul');
    list.className = 'rf-ms__dropdown';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-multiselectable', 'true');

    function selectedIds()   { return Object.keys(_selected); }
    function selectedNames() { return selectedIds().map(function (id) { return _selected[id]; }); }

    function renderChips() {
      chipsWrap.innerHTML = '';
      selectedIds().forEach(function (id) {
        var chip = document.createElement('span');
        chip.className = 'rf-ms__chip';

        var label = document.createElement('span');
        label.className = 'rf-ms__chip-label';
        label.textContent = _selected[id];

        var remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'rf-ms__chip-remove';
        remove.innerHTML = RfIE.icons.x;
        remove.setAttribute('aria-label', 'Remove ' + _selected[id]);
        remove.addEventListener('mousedown', function (e) {
          e.preventDefault();
          e.stopPropagation();
          toggle(id, _selected[id], false);
        });

        chip.appendChild(label);
        chip.appendChild(remove);
        chipsWrap.appendChild(chip);
      });
      input.placeholder = selectedIds().length ? '' : (cfg.placeholder || rfI18n('search'));
    }

    function toggle(id, name, forceState) {
      id = String(id);
      var nextState = forceState != null ? forceState : !_selected.hasOwnProperty(id);
      if (nextState) { _selected[id] = name; } else { delete _selected[id]; }
      renderChips();
      buildList(input.value);
    }

    function buildList(filter) {
      list.innerHTML = '';
      _focusIdx = -1;
      var lf = filter ? filter.toLowerCase() : '';
      var visible = lf
        ? options.filter(function (o) { return o.name.toLowerCase().indexOf(lf) >= 0; })
        : options;

      if (!visible.length) {
        var empty = document.createElement('li');
        empty.className = 'rf-ms__option rf-ms__option--empty';
        empty.textContent = 'No results';
        list.appendChild(empty);
        return;
      }

      visible.forEach(function (opt) {
        var id = String(opt.id);
        var checked = _selected.hasOwnProperty(id);

        var li = document.createElement('li');
        li.className = 'rf-ms__option' + (checked ? ' rf-ms__option--selected' : '');
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', checked ? 'true' : 'false');
        li.setAttribute('data-rf-id', id);
        li.setAttribute('data-rf-name', opt.name);

        var box = document.createElement('span');
        box.className = 'rf-ms__checkbox';
        if (checked) box.innerHTML = RfIE.icons.check;

        var label = document.createElement('span');
        label.className = 'rf-ms__option-label';
        label.textContent = opt.name;

        li.appendChild(box);
        li.appendChild(label);

        /* mousedown (not click) + preventDefault, matching SearchableSelect,
           so selecting an option doesn't blur the input first. Toggling does
           NOT close the dropdown — multi-select needs to stay open across
           several picks. */
        li.addEventListener('mousedown', function (e) {
          e.preventDefault();
          toggle(id, opt.name);
        });
        list.appendChild(li);
      });
    }

    function reposition() { if (_open) RfIE.positionDropdown(control, list); }

    function openList() {
      /* See RfIE.SearchableSelect's identical guard: skip if this instance
         was never actually inserted into the page (aborted async render). */
      if (!document.body.contains(control)) return;
      buildList(input.value);
      if (!list.parentNode) document.body.appendChild(list);
      list.classList.add('rf-ms__dropdown--open');
      _open = true;
      RfIE.positionDropdown(control, list);
      window.addEventListener('scroll', reposition, true);
      window.addEventListener('resize', reposition);
    }

    function closeList() {
      list.classList.remove('rf-ms__dropdown--open');
      _open = false;
      _focusIdx = -1;
      input.value = '';
      if (list.parentNode) list.parentNode.removeChild(list);
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    }

    function moveFocus(delta) {
      var items = list.querySelectorAll('.rf-ms__option:not(.rf-ms__option--empty)');
      if (!items.length) return;
      _focusIdx = Math.max(0, Math.min(_focusIdx + delta, items.length - 1));
      items.forEach(function (li, i) {
        li.classList.toggle('rf-ms__option--focused', i === _focusIdx);
      });
      if (items[_focusIdx]) items[_focusIdx].scrollIntoView({ block: 'nearest' });
    }

    /* Clicking anywhere on the control (but not directly on a chip's remove
       button, which stops propagation) focuses the search input. */
    control.addEventListener('mousedown', function (e) {
      if (e.target === input) return;
      e.preventDefault();
      input.focus();
    });

    /* ── Events ── */
    input.addEventListener('focus', openList);
    input.addEventListener('input', openList);
    input.addEventListener('blur', function () { setTimeout(closeList, 160); });

    input.addEventListener('keydown', function (e) {
      if (!_open && (e.key === 'ArrowDown' || e.key === 'Enter')) {
        e.preventDefault();
        openList();
        return;
      }
      if (e.key === 'ArrowDown') { e.preventDefault(); moveFocus(1); }
      if (e.key === 'ArrowUp')   { e.preventDefault(); moveFocus(-1); }
      if (e.key === 'Escape')    { closeList(); }
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        var items = list.querySelectorAll('.rf-ms__option:not(.rf-ms__option--empty)');
        if (_focusIdx >= 0 && items[_focusIdx]) {
          toggle(items[_focusIdx].dataset.rfId, items[_focusIdx].dataset.rfName);
        }
      }
      /* Backspace on an empty search box pops the last-added chip — the
         usual multi-select-with-chips convention. */
      if (e.key === 'Backspace' && !input.value) {
        var ids = selectedIds();
        if (ids.length) toggle(ids[ids.length - 1], _selected[ids[ids.length - 1]], false);
      }
    });

    renderChips();

    /* ── Public API ── */
    wrapper.getValues  = selectedIds;
    wrapper.getNames   = selectedNames;
    wrapper.focusInput = function () { input.focus(); };

    return wrapper;
  };

  /* ── Click-outside detection helper ─────────────────────────── */
  /**
   * Call onOutside whenever a click occurs outside `el`.
   * Returns a dispose function that removes the listener.
   */
  RfIE.onClickOutside = function (el, onOutside) {
    function handler(e) {
      if (el.contains(e.target)) return;
      /* RfIE.SearchableSelect and RfIE.MultiSelect both portal their dropdown
         list to document.body while open (so it isn't clipped by scrollable
         ancestors like the issue list table's div.autoscroll) — the list is
         therefore never a DOM descendant of `el` even though it's part of
         the same logical editor. Without this, clicking an option would
         register as an outside click and cancel the edit on the same click
         that selects it. */
      if (e.target.closest && e.target.closest('.rf-ss__dropdown, .rf-ms__dropdown')) return;
      onOutside(e);
    }
    document.addEventListener('click', handler, true);
    return function () { document.removeEventListener('click', handler, true); };
  };

  /**
   * Set up Escape-key handler that calls callback once.
   * Returns a dispose function.
   */
  RfIE.onEscape = function (cb) {
    function handler(e) {
      if (e.key === 'Escape' || e.key === 'Esc') cb(e);
    }
    document.addEventListener('keydown', handler);
    return function () { document.removeEventListener('keydown', handler); };
  };


}(window, document));
