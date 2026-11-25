class IssueTablesController < ApplicationController
  # Allow API-key authentication in addition to session auth
  accept_api_auth :fetch_active_members, :fetch_issue_allowed_status,
                  :all_custom_fields, :all_projects, :all_versions,
                  :check_agile_board_enabled, :issue_images,
                  :update_issue_field, :agile_story_points, :fetch_sprints

  # Needed by the core API templates rendered in rf_issue / rf_project below:
  # render_api_custom_values lives in CustomFieldsHelper, render_api_includes in
  # ProjectsHelper. Redmine's own controllers pull these in the same way.
  helper :custom_fields
  helper :projects
  helper :journals
  helper :issue_relations
  helper :attachments

  before_action :require_login

  # CSRF: the token check is skipped ONLY for a call that authenticates with an API key (on an action listed in
  # accept_api_auth) and carries no browser session - nothing a forged cross-site request could ride on. Every
  # request that comes with the browser's session keeps the check. These routes are not JSON-format routes, so
  # without this an API-key call could never pass the token check at all.
  skip_before_action :verify_authenticity_token,
                     if: -> { accept_api_auth? && api_key_from_request.present? && session[:user_id].blank? }


  # ── Stand-ins for the parts of Redmine's own REST API the editor needs ────
  #
  # The editor used to call /issues/:id.json, /projects/:id.json and friends
  # directly. Those are API-format routes, and Redmine deliberately will not
  # authenticate an API-format request from a browser session -
  # ApplicationController#find_current_user skips the session outright whenever
  # the format is json or xml, leaving only an API key or HTTP Basic. So those
  # calls only ever worked because the editor sent the signed-in user's API key
  # with every request, which is the problem #121123 describes.
  #
  # These routes carry no JSON format, so the session is honoured, and each one
  # renders Redmine's own API template - the responses stay exactly what the
  # editor already expects, with no second copy of the shape to drift. Each
  # checks the same permission its core counterpart checks.

  def rf_issue
    @issue = Issue.visible.find_by(id: params[:id])
    return render(json: { errors: ['Issue not found'] }, status: :not_found) unless @issue

    @project = @issue.project
    render_core_api 'issues/show', includes: %w[children attachments]
  end

  def rf_project
    @project = find_visible_project
    return render(json: { errors: ['Project not found'] }, status: :not_found) unless @project

    render_core_api 'projects/show', includes: %w[trackers issue_categories enabled_modules time_entry_activities issue_custom_fields]
  end

  # Mirrors ProjectsController#update: full validation, and 204 with no body on
  # success, exactly as the core API answers.
  def rf_update_project
    @project = find_visible_project
    return render(json: { errors: ['Project not found'] }, status: :not_found) unless @project
    unless User.current.allowed_to?(:edit_project, @project)
      return render(json: { errors: ['Forbidden'] }, status: :forbidden)
    end

    @project.safe_attributes = params[:project]
    if @project.save
      head :no_content
    else
      render json: { errors: @project.errors.full_messages }, status: :unprocessable_entity
    end
  end

  def rf_issue_priorities
    @klass = IssuePriority
    @enumerations = @klass.shared.sorted.to_a
    render_core_api 'enumerations/index'
  end

  def rf_issue_categories
    @project = find_visible_project
    return render(json: { errors: ['Project not found'] }, status: :not_found) unless @project
    unless User.current.allowed_to?(:view_issues, @project)
      return render(json: { errors: ['Forbidden'] }, status: :forbidden)
    end

    @categories = @project.issue_categories.to_a
    render_core_api 'issue_categories/index'
  end

  # ── Active members for a project ──────────────────────────────────────────
  def fetch_active_members
    project = find_editable_project
    return unless project

    members = project.users.where(status: User::STATUS_ACTIVE)
                           .map { |u| { id: u.id, name: u.name } }
                           .sort_by { |m| m[:name] }
    render json: { active_members: members }
  end

  # ── Workflow-allowed statuses for an issue ────────────────────────────────
  def fetch_issue_allowed_status
    issue = find_visible_issue
    unless issue
      render json: { error: 'Issue not found' }, status: :not_found and return
    end
    # Same :edit_issues-only bug as update_issue_field below — a user with
    # only :edit_own_issues editing the Status field on their own issue must
    # still be able to fetch the allowed transitions for it.
    unless issue.attributes_editable?(User.current)
      render json: { error: 'Forbidden' }, status: :forbidden and return
    end

    statuses = issue.new_statuses_allowed_to(User.current)
    render json: { allowed_status: statuses.map { |s| { id: s.id, name: s.name } } }
  end

  # ── All projects visible to current user ──────────────────────────────────
  def all_projects
    projects = Project.visible.map { |p| { id: p.id, name: p.name } }
    render json: { projects: projects }
  end

  # ── Custom field definitions (for issue-table & project custom field editing)
  def all_custom_fields
    # Only expose fields the user could realistically encounter
    # Only the issue and project fields the editor works on, and only those the current user may see
    # (a field hidden from the user's roles is not listed, nor are its possible values).
    fields = CustomField.visible.where(type: %w[IssueCustomField ProjectCustomField]).map do |cf|
      # Enumeration CFs return ActiveRecord objects from possible_values;
      # normalise to [{id, label}] so the JS can build a dropdown directly.
      # Bool CFs don't store any possible_values in the DB (there's nothing
      # to configure — it's always Yes/No) so cf.possible_values is just [];
      # the format object itself is the only place the localized Yes/No
      # labels exist server-side, so pull them from there in the same shape.
      pv = if cf.field_format == 'enumeration'
             # cf.possible_values (CustomField#possible_values, app/models/
             # custom_field.rb) reads the legacy raw `possible_values` DB
             # column, which is only populated for plain "list" CFs. An
             # enumeration ("Key/Value list") CF stores its options via the
             # cf.enumerations association (CustomFieldEnumeration records)
             # instead — same source Redmine's own EnumerationFormat uses
             # (lib/redmine/field_format.rb, possible_values_records: cf.
             # enumerations.active) — so cf.possible_values was always [],
             # meaning no enumeration CF ever sent any options to the JS.
             cf.enumerations.active.map { |e| { id: e.id, label: e.name } }
           elsif cf.field_format == 'bool'
             cf.format.possible_values_options(cf).map { |label, id| { id: id, label: label } }
           elsif cf.field_format == 'progressbar'
             # Progressbar CFs don't store possible_values in the DB either — like
             # bool, the option list is generated dynamically. Core's own edit_tag
             # (lib/redmine/field_format.rb ProgressbarFormat#edit_tag) builds it as
             # (0..100).step(ratio_interval).to_a from the CF's configured "Ratio
             # interval" (cf.ratio_interval), falling back to
             # Setting.issue_done_ratio_interval when unset (mirrors
             # ProgressbarFormat#before_custom_field_save). Reproduce that exact
             # calculation here so the JS dropdown offers the configured interval
             # instead of a hardcoded 10% step.
             interval = cf.ratio_interval.presence || Setting.issue_done_ratio_interval.to_i
             (0..100).step(interval.to_i).to_a.map { |r| { id: r, label: "#{r} %" } }
           else
             cf.possible_values
           end
      {
        id:               cf.id,
        name:             cf.name,
        customized_type:  cf.class.name.gsub('CustomField', ''),
        field_format:     cf.field_format,
        possible_values:  pv,
        multiple:         cf.multiple,
        is_required:      cf.is_required,
        visible:          cf.visible,
        # Display format for list-like fields (bool/list): '' (or nil) = dropdown,
        # 'check_box' = checkbox(es), 'radio' = radio buttons. The JS needs this to
        # decide whether a "— None —" option should ever be offered — Redmine only
        # supports clearing an optional value via the dropdown rendering; the
        # checkbox/radio renderings for a Boolean CF never show a blank choice.
        edit_tag_style:   cf.respond_to?(:edit_tag_style) ? cf.edit_tag_style : nil,
        # Empty array = applies to all trackers; non-empty = restricted to listed tracker IDs.
        # Used by JS to pre-disable edit icons for inapplicable CF cells.
        tracker_ids:      cf.is_a?(IssueCustomField) ? cf.trackers.pluck(:id) : []
      }
    end
    render json: fields
  end

  # ── Versions shared with / open for a project ─────────────────────────────
  def all_versions
    project = find_editable_project
    return unless project

    versions = project.shared_versions.open.sort.map do |v|
      label = params[:indata] == 'yes' && v.project == project ? v.to_s : "#{v.project} - #{v}"
      { id: v.id, name: label }
    end
    render json: { version: versions }
  end

  # ── Agile board detection (for sprint field visibility) ───────────────────
  def check_agile_board_enabled
    issue = find_visible_issue
    # Missing and hidden issues answer alike, so the answer does not tell whether an id exists.
    render json: { agile_board_enabled: false }, status: :not_found and return unless issue
    enabled = issue.project.enabled_modules.any? { |m| m.name == 'agile_board' }
    render json: { agile_board_enabled: enabled }
  end

  # ── Sprints for a project (proxy — agile plugin API requires API-key auth) ──
  # Accepts numeric project id or identifier string.
  def fetch_sprints
    project = find_editable_project
    return unless project

    sprints = []
    if defined?(SprintCraft)
      sprints = SprintCraft.where(project_id: project.id).order(:name)
                           .map { |s| { id: s.id, name: s.name } }
    end
    render json: { sprints: sprints }
  end

  # ── Agile board story-point values (no dedicated endpoint in agile plugin) ──
  def agile_story_points
    settings = defined?(Setting.plugin_agile_board) ? (Setting.plugin_agile_board || {}) : {}
    raw = settings['story_point_values'].presence || '0,1,2,3,5,8,13,21,34,55,89'
    values = raw.split(',').map(&:strip).select(&:present?).uniq
    render json: { story_point_values: values }
  end

  # ── Attachment lookup (used by description image rendering) ───────────────
  def issue_images
    issue_id   = params[:issueId].to_i
    image_name = ActionView::Base.full_sanitizer.sanitize(params[:imageName].to_s)

    issue = find_visible_issue(issue_id)
    unless issue
      render json: { error: 'Issue not found' }, status: :not_found and return
    end

    attachment = Attachment.where(
      container_id:   issue_id,
      container_type: 'Issue',
      filename:       image_name
    ).first

    if attachment
      # Only what the editor needs - not the stored file name, digest or author.
      render json: { attachment: attachment.as_json(only: %i[id filename filesize content_type description created_on]) }
    else
      render json: { error: 'Image not found' }, status: :not_found
    end
  end

  # ── Partial inline update — skips unrelated required-field validations ────────
  # Redmine's native PUT /issues/:id.json runs ALL validations, so a required
  # custom field ("Float field can't be blank") blocks a simple tracker change.
  # This action uses save(validate: false) to bypass other-field validation while
  # still recording a proper journal entry via init_journal.
  def update_issue_field
    issue = find_visible_issue
    return render json: { errors: ['Issue not found'] }, status: :not_found unless issue
    # Issue#attributes_editable? is core's own authoritative check — true
    # either via :edit_issues (any issue) or via :edit_own_issues + authorship
    # of THIS issue. A plain allowed_to?(:edit_issues, ...) check here always
    # 403'd a user who only has :edit_own_issues, even when saving their own
    # issue — the frontend had the matching bug (fixed separately), but this
    # server-side check is what actually rejected the save.
    return render json: { errors: ['Forbidden'] }, status: :forbidden \
      unless issue.attributes_editable?(User.current)

    # Record a journal so the change appears in Redmine history
    issue.init_journal(User.current)

    # The body must be {"issue": {attribute: scalar, ..., custom_field_values: {id: scalar-or-list}}}. Anything
    # else (text or a list where an object is expected, a list where a number is expected) used to end in a
    # server error; a NUL character cannot be stored. Answer 422 / drop the character instead.
    unless params[:issue].respond_to?(:to_unsafe_h)
      return render json: { errors: ["Value can't be blank"] }, status: :unprocessable_entity
    end
    issue_params = without_null_bytes(params[:issue].to_unsafe_h)
    unless well_formed_issue_params?(issue_params)
      return render json: { errors: ['Invalid value'] }, status: :unprocessable_entity
    end

    # Detect custom_field_values requests before applying safe_attributes so we
    # can verify they were actually accepted after the save (Redmine silently
    # drops CF values for CFs not assigned to the issue's tracker).
    requested_cf_ids = (issue_params['custom_field_values'] || {}).keys.map(&:to_i)

    # Convert to a plain Ruby Hash so nested keys like custom_field_values
    # survive Redmine's `is_a?(Hash)` guard in custom_field_values=.
    # ActionController::Parameters is NOT a Hash subclass in Rails 6+, so
    # passing params[:issue] directly causes custom_field_values to be silently
    # ignored even though flat attributes (tracker_id, status_id, etc.) work fine.
    # Redmine quietly ignores any attribute the workflow marks read-only for
    # this user at this status - safe_attributes= filters them out instead of
    # complaining - so a save that changed nothing still came back a success and
    # the editor told the user it had been saved (#121113). Ask the same question
    # Redmine asks, and refuse before applying anything.
    read_only_names = issue.read_only_attribute_names(User.current)
    requested_names = issue_params.keys.reject { |k| k == 'custom_field_values' } +
                      requested_cf_ids.map(&:to_s)
    if (requested_names & read_only_names).any?
      return render json: {
        errors: ['This field cannot be changed while the issue is at its current status.']
      }, status: :forbidden
    end

    issue.safe_attributes = issue_params

    # A single-field edit — from either the issue details page or the issue
    # list page, both of which save through this action — must not silently
    # go through while some OTHER field on the issue is required (either via
    # Administration > Workflow > Fields permissions, status-dependent, or
    # via the custom field's own "Required" checkbox). save(validate: false)
    # below never runs either check, so without this the inline editor would
    # happily update e.g. the assignee while a required field is still blank
    # — Redmine's own full-form save would reject that. Rather than trying to
    # surface every one of those (possibly several) missing fields in this
    # single-field editor's small panel, tell the frontend to resubmit this
    # same field change as a real form POST to Redmine's own update action
    # (RfIE.submitEditForm) so its native validation-failure rendering — the
    # standard "N errors prohibited this issue from being saved" box — takes
    # over, exactly as if the user had submitted the full Edit form.
    #
    # Excludes requested_cf_ids — the field(s) THIS request is actually
    # editing — because those already get a direct, friendly error below
    # (via CustomFieldValue#validate_value, e.g. "User can't be blank") if
    # the user cleared a required field they're editing right now. Without
    # this exclusion, clearing a required field always won the race against
    # that check and redirected to the full Edit form even for this
    # self-contained case, where a plain in-place error is clearer and
    # doesn't need a full-page round trip.
    if missing_required_attribute_names(issue, exclude_cf_ids: requested_cf_ids).any?
      return render json: { redirect_to_edit: true }, status: :unprocessable_entity
    end

    # save(validate: false) below deliberately bypasses ALL model validations
    # so that an unrelated required field ("Float field can't be blank") never
    # blocks a single-field inline edit (see comment above). That means
    # Issue#validate_issue — including Redmine's own
    # "due_date >= start_date" rule (app/models/issue.rb, validate_issue,
    # `errors.add :due_date, :greater_than_start_date`) — never runs either,
    # so the inline editor silently accepted a start date after the due date
    # (or vice versa) with no feedback to the user.
    #
    # Re-running full validation here would reintroduce the exact problem
    # validate:false was added to solve, so instead we replicate just this one
    # rule — mirroring validate_issue's own condition — for the two attributes
    # this endpoint actually lets the user change. A more general "validate
    # only the changed attribute(s)" mechanism would be needed to safely cover
    # every other per-field cross-validation without this kind of duplication;
    # that is out of scope here.
    if issue.due_date && issue.start_date &&
       (issue.start_date_changed? || issue.due_date_changed?) &&
       issue.due_date < issue.start_date
      issue.errors.add(:due_date, :greater_than_start_date)
      return render json: { errors: issue.errors.full_messages }, status: :unprocessable_entity
    end

    # Likewise, validate:false skips CustomFieldValue validation entirely, so
    # clearing a *required* custom field via this endpoint (e.g. blanking a
    # required Date CF) saved successfully with no error — Issue's own
    # validate_custom_field_values (lib/plugins/acts_as_customizable/lib/
    # acts_as_customizable.rb) was never reached to catch it. Re-validate,
    # but only the custom field(s) actually present in this request — i.e.
    # the one(s) just edited — via CustomFieldValue#validate_value directly
    # (app/models/custom_field_value.rb; it adds straight to issue.errors).
    # This deliberately does NOT call Issue#validate_custom_field_values,
    # which would validate every editable CF on the issue and reintroduce
    # the "unrelated required field blocks this save" problem validate:false
    # was added to solve.
    unless requested_cf_ids.empty?
      issue.custom_field_values.each do |cfv|
        cfv.validate_value if requested_cf_ids.include?(cfv.custom_field_id)
      end
      if issue.errors.any?
        return render json: { errors: issue.errors.full_messages }, status: :unprocessable_entity
      end
    end

    # Likewise, validate:false skips Issue's own
    # `validates :estimated_hours, :numericality => {...}` check (app/models/
    # issue.rb, ~line 76), so garbage input like "10:9k" never gets rejected.
    # Worse, it isn't even caught downstream: Issue#estimated_hours= (app/
    # models/issue.rb ~line 492) does
    #   write_attribute :estimated_hours, (h.is_a?(String) ? (h.to_hours || h) : h)
    # — String#to_hours (lib/redmine/core_ext/string/conversions.rb) parses
    # plain decimals ("5.5") and h:mm/h/m forms ("10:30", "2h30", "30m"), and
    # returns nil for anything else, in which case the setter falls back to
    # writing the RAW STRING itself into the estimated_hours attribute. That
    # raw string then goes through ActiveRecord's float type cast the next
    # time the attribute is read/saved, and Ruby's String#to_f silently reads
    # only the leading numeric run ("10:9k".to_f => 10.0) instead of raising —
    # so the bad input isn't just unvalidated, it gets silently corrupted into
    # a different, "valid-looking" number by the time any validator (or our
    # own re-checks above) would look at issue.estimated_hours. To catch this
    # we must parse the ORIGINAL request string ourselves, before it's ever
    # assigned/cast, and only when estimated_hours was actually part of this
    # request (consistent with the due-date and custom-field checks above).
    if issue_params.key?('estimated_hours')
      raw_estimated_hours = issue_params['estimated_hours'].to_s.strip
      if raw_estimated_hours.present?
        parsed_estimated_hours = raw_estimated_hours.to_hours
        if parsed_estimated_hours.nil? || parsed_estimated_hours < 0
          issue.errors.add(:estimated_hours, :invalid)
          return render json: { errors: issue.errors.full_messages }, status: :unprocessable_entity
        end
      end
    end

    # Likewise, validate:false skips Issue's own validates_presence_of :subject
    # and validates_length_of :subject, maximum: 255 (app/models/issue.rb), so
    # this endpoint accepted a blank subject, and one of any length at all - a
    # 5,000-character subject saved cleanly here while the full Edit form
    # rejected the very same value, and it then broke the issue list's column
    # layout (#121112). The input's own maxlength attribute only limits typing;
    # it does not limit what reaches this endpoint. Checked only when subject is
    # part of this request, consistent with the per-field checks above.
    if issue_params.key?('subject')
      issue.errors.add(:subject, :blank) if issue.subject.blank?
      issue.errors.add(:subject, :too_long, count: 255) if issue.subject.to_s.length > 255
      if issue.errors.any?
        return render json: { errors: issue.errors.full_messages }, status: :unprocessable_entity
      end
    end

    # status, tracker, project and priority are filtered by safe_attributes= (workflow, allowed trackers and
    # target projects): a value that is not allowed is DROPPED without a word, and the editor then told the
    # user the change was saved. Refuse instead.
    refused = dropped_id_attributes(issue, issue_params)
    return render json: { errors: refused }, status: :unprocessable_entity if refused.any?

    # save(validate: false) below skips every model validation, so the values the user chose were never
    # checked the way the normal form checks them: an assignee who is not a project member, a version or
    # category of another project, a progress of 5000, a parent that is the issue itself were all saved.
    # Run the model's own validation and refuse on the errors that belong to the fields THIS request sets
    # - errors of other fields (a required field that is still empty) stay out of the way, as designed.
    request_errors = errors_for_requested_fields(issue, issue_params.keys)
    return render json: { errors: request_errors }, status: :unprocessable_entity if request_errors.any?

    if issue.save(validate: false)
      # Build the saved CF map keyed by id for quick lookup
      cfs = issue.custom_field_values.map do |cfv|
        { id: cfv.custom_field_id, name: cfv.custom_field.name, value: cfv.value }
      end
      saved_cf_ids = cfs.map { |c| c[:id] }

      # If any requested CF was silently dropped (not in available_custom_fields
      # for this issue's tracker/project), return a clear error so the UI can
      # show the user what went wrong instead of silently showing '—'.
      dropped = requested_cf_ids - saved_cf_ids
      if dropped.any?
        return render json: {
          errors: ['This field is not available for this issue type. ' \
                   'Please contact your administrator if you need access.']
        }, status: :unprocessable_entity
      end

      render json: {
        issue: {
          id:              issue.id,
          lock_version:    issue.lock_version,
          subject:         issue.subject,
          start_date:      issue.start_date,
          due_date:        issue.due_date,
          done_ratio:      issue.done_ratio,
          estimated_hours: issue.estimated_hours,
          # Formatted the same way Redmine's own list column renders it
          # (respects Setting.timespan_format, e.g. "5:30" vs "5.5") so the
          # inline editor's post-save display matches what a page refresh
          # will show — otherwise the raw float shown immediately after
          # save disagrees with the h:mm text shown after refresh, and
          # re-opening the editor on that h:mm text mis-parses it.
          estimated_hours_formatted: issue.estimated_hours ? format_hours(issue.estimated_hours) : nil,
          assigned_to:     issue.assigned_to  ? { id: issue.assigned_to.id,   name: issue.assigned_to.name }   : nil,
          status:          issue.status       ? { id: issue.status.id,         name: issue.status.name }         : nil,
          priority:        issue.priority     ? { id: issue.priority.id,       name: issue.priority.name }       : nil,
          tracker:         issue.tracker      ? { id: issue.tracker.id,        name: issue.tracker.name }        : nil,
          category:        issue.category     ? { id: issue.category.id,       name: issue.category.name }       : nil,
          fixed_version:   issue.fixed_version ? { id: issue.fixed_version.id, name: issue.fixed_version.name } : nil,
          project:         issue.project      ? { id: issue.project.id,        name: issue.project.name }        : nil,
          custom_fields:   cfs
        }
      }
    else
      render json: { errors: issue.errors.full_messages.presence || ['Save failed'] },
             status: :unprocessable_entity
    end
  rescue ActionController::ParameterMissing
    # Raised when the request body carries no "issue" key at all (e.g. an
    # empty/all-blank payload) — Rails' own exception message ("param is
    # missing or the value is empty: issue") is meaningless to an end user,
    # so surface it as the same kind of validation error a real blank
    # required field would show instead of a raw framework error.
    render json: { errors: ["Value can't be blank"] }, status: :unprocessable_entity
  rescue ActiveRecord::StaleObjectError
    # Someone else changed the issue after this page was loaded: do not overwrite it silently.
    render json: { errors: [I18n.t('label_rf_stale_object_conflict', default: 'The issue may have been modified by another user. Please reload the page and try again.')],
                   stale: true },
           status: :conflict
  rescue => e
    # The details go to the log, never to the caller (class names, SQL, file paths).
    logger.error("[inplace_issue_editor] #{e.class}: #{e.message}") if logger
    render json: { errors: [I18n.t('label_rf_generic_save_error', default: 'The change could not be saved.')] },
           status: :internal_server_error
  end

  private

  # The issue, found only among the ones the current user may see (core's own find_issue does the same
  # before it authorizes anything). Issue#attributes_editable? alone does not check visibility.
  def find_visible_issue(id = params[:id])
    id = id.to_s
    return nil unless id.match?(/\A\d+\z/)

    Issue.visible.find_by(id: id)
  end

  # The project, for the lists the editor fills its drop-downs from (members, versions, sprints). Those are
  # needed by people who edit issues or the project, not by every member who can merely look.
  def find_editable_project
    project = find_project_with_permission(:view_project)
    return nil unless project

    user = User.current
    allowed = user.allowed_to?(:edit_issues, project) || user.allowed_to?(:edit_own_issues, project) ||
              user.allowed_to?(:edit_project, project)
    render json: { error: 'Forbidden' }, status: :forbidden and return nil unless allowed

    project
  end

  SCALAR = [String, Numeric, NilClass, TrueClass, FalseClass].freeze

  def without_null_bytes(value)
    case value
    when String then value.delete("\u0000")
    when Hash then value.each_with_object({}) { |(k, v), h| h[k.to_s.delete("\u0000")] = without_null_bytes(v) }
    when Array then value.map { |v| without_null_bytes(v) }
    else value
    end
  end

  # {attribute: scalar}, and custom_field_values: {id: scalar or list of scalars}.
  def well_formed_issue_params?(issue_params)
    issue_params.all? do |key, value|
      if key == 'custom_field_values'
        value.is_a?(Hash) && value.all? { |_id, v| scalar?(v) || (v.is_a?(Array) && v.all? { |e| scalar?(e) }) }
      else
        scalar?(value)
      end
    end
  end

  def scalar?(value)
    SCALAR.any? { |klass| value.is_a?(klass) }
  end

  # Names of the id attributes safe_attributes= refused to set although the request asked for them.
  def dropped_id_attributes(issue, issue_params)
    %w[status_id tracker_id project_id priority_id].filter_map do |key|
      wanted = issue_params[key].to_s
      next if wanted.blank? || issue.public_send(key).to_s == wanted

      "#{Issue.human_attribute_name(key.sub(/_id\z/, ''))} cannot be set to that value"
    end
  end

  # Errors the model's validation raises for the attributes this request sets (and only those).
  def errors_for_requested_fields(issue, keys)
    names = keys.map(&:to_s) - %w[custom_field_values lock_version notes private_notes]
    return [] if names.empty?

    issue.valid?
    wanted = names.flat_map { |k| [k.to_sym, k.sub(/_id\z/, '').to_sym] }
    # Rules about the status, version, parent or project of an issue are reported on the issue as a whole.
    wanted << :base if (names & %w[status_id fixed_version_id parent_issue_id project_id]).any?
    issue.errors.objects.select { |e| wanted.include?(e.attribute) }.map(&:full_message).uniq
  end

  # Names of currently-required attributes whose value is blank on `issue`
  # right now, from TWO independent "required" sources Redmine has:
  #
  # 1. Issue#required_attribute_names (native attribute names, or custom
  #    field ids as digit strings) — status-dependent workflow field
  #    permissions (Administration > Workflow > Fields permissions). Mirrors
  #    Issue#validate_required_fields (app/models/issue.rb, private) exactly.
  #
  # 2. A custom field's OWN "Required" checkbox (CustomField#is_required,
  #    set on the field itself in Administration > Custom fields) — a
  #    completely separate mechanism, checked via
  #    CustomField#validate_custom_value/CustomFieldValue#validate_value, NOT
  #    via required_attribute_names. This is the more common "required
  #    field" a user sets up, so missing this meant the redirect never fired
  #    for the ordinary case of a plain required custom field — only for the
  #    much rarer per-status workflow permission case.
  #
  # Both bypass save(validate: false) below entirely, so both are
  # reimplemented here as standalone checks rather than called directly
  # (they're private / only usable as `validate` callbacks).
  def missing_required_attribute_names(issue, exclude_cf_ids: [])
    user = User.current
    # A field the current tracker+status+role workflow marks "readonly"
    # can't be filled in by this user right now — not via this editor, not
    # via the list page, not even via Redmine's own full Edit form, which
    # renders it as static text. CustomField#is_required is a per-field flag
    # independent of workflow rules, so a field can be BOTH globally required
    # AND currently readonly (e.g. a value that becomes locked once derived/
    # computed past a certain status) — without this exclusion, that
    # combination made every single-field edit on the issue redirect to the
    # Edit form forever, since the "missing" field could never actually be
    # filled there either.
    read_only = issue.read_only_attribute_names(user)

    from_workflow = issue.required_attribute_names(user).select do |attribute|
      next false if read_only.include?(attribute)
      if /^\d+$/.match?(attribute)
        cfv = issue.custom_field_values.detect { |v| v.custom_field_id == attribute.to_i }
        cfv && Array(cfv.value).detect(&:present?).nil?
      else
        next false unless issue.respond_to?(attribute)
        next false if issue.send(:disabled_core_fields).include?(attribute)
        next false if attribute == 'category_id' && issue.project.try(:issue_categories).blank?
        next false if attribute == 'fixed_version_id' && issue.assignable_versions.blank?
        issue.send(attribute).blank?
      end
    end

    from_custom_field_flag = issue.custom_field_values.select do |cfv|
      cfv.custom_field.is_required? &&
        !read_only.include?(cfv.custom_field_id.to_s) &&
        !exclude_cf_ids.include?(cfv.custom_field_id) &&
        Array(cfv.value).detect(&:present?).nil?
    end.map { |cfv| cfv.custom_field_id.to_s }

    (from_workflow + from_custom_field_flag).uniq
  end

  # Redmine's api templates choose XML or JSON from params[:format]. Nothing has
  # read it since authentication finished, so setting it here only decides how
  # the response is built - it cannot affect who the request was authenticated
  # as, which has already been settled from the session.
  def render_core_api(template, includes: nil)
    params[:format] = 'json'
    # ?include= decides which extra blocks the core template renders; some of those need data only core's own
    # controller prepares (journals, allowed statuses, ...), and failed with a server error here. Offer only
    # the ones that work for the stand-in.
    params[:include] = (params[:include].to_s.split(',').map(&:strip) & includes).join(',') if includes
    render template: template, formats: [:api], content_type: 'application/json'
  end

  # The editor addresses projects by id on some pages and by identifier on
  # others, the same way Redmine's own URLs do.
  def find_visible_project
    id = params[:id].to_s
    return nil unless id.match?(/\A[\w-]+\z/)

    scope = Project.visible
    id.match?(/\A\d+\z/) ? scope.find_by(id: id) : scope.find_by(identifier: id)
  end

  def find_project_with_permission(perm)
    id_param = params[:id].to_s
    project = !id_param.match?(/\A[\w-]+\z/) ? nil : id_param.match?(/\A\d+\z/) ? Project.find_by(id: id_param) : Project.find_by(identifier: id_param)
    if project.nil?
      render json: { error: 'Project not found' }, status: :not_found
      return nil
    end
    unless User.current.allowed_to?(perm, project)
      render json: { error: 'Forbidden' }, status: :forbidden
      return nil
    end
    project
  end
end
