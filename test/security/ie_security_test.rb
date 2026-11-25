require File.expand_path('../../test_helper', __FILE__)

# Inplace Issue Editor security review (IE-01 and following).
#
# Every test asserts the SECURE behaviour: it fails on the old code and passes after the fix, and each group has a
# "legitimate user still works" test. Holdout tests - never relaxed, renamed or deleted to make a build pass.
class IeSecurityTest < ActionDispatch::IntegrationTest
  fixtures :projects, :users, :email_addresses, :roles, :members, :member_roles, :enabled_modules,
           :issue_statuses, :trackers, :projects_trackers, :enumerations, :workflows, :issue_categories,
           :custom_fields, :custom_fields_projects, :custom_fields_trackers

  JSON_HEADERS = { 'Accept' => 'application/json', 'CONTENT_TYPE' => 'application/json' }.freeze

  def setup
    @password = 'Ie-pass-1234!'
    Setting.rest_api_enabled = '1'
    @project = Project.find(1)
    @project.update_columns(is_public: false)
    @project.enable_module!(:issue_tracking)

    full = Role.generate!(permissions: %i[view_issues add_issues edit_issues add_issue_notes manage_versions manage_subtasks], issues_visibility: 'all')
    own_only = Role.generate!(permissions: %i[view_issues add_issues edit_issues], issues_visibility: 'own')
    read_only = Role.generate!(permissions: %i[view_issues], issues_visibility: 'all')
    @not_assignable = Role.generate!(permissions: %i[view_issues], issues_visibility: 'all', assignable: false)

    @author = make_user('ie-author')
    Member.create!(project: @project, user: @author, roles: [full])
    @editor = make_user('ie-editor')
    Member.create!(project: @project, user: @editor, roles: [full])
    @restricted = make_user('ie-restricted')
    Member.create!(project: @project, user: @restricted, roles: [own_only])
    @viewer = make_user('ie-viewer')
    Member.create!(project: @project, user: @viewer, roles: [read_only])
    @watcher_only = make_user('ie-noassign')
    Member.create!(project: @project, user: @watcher_only, roles: [@not_assignable])
    @outsider = make_user('ie-outsider')

    @issue = Issue.generate!(project: @project, author: @author, subject: 'IE ordinary issue')
    @private_issue = Issue.generate!(project: @project, author: @author, is_private: true, subject: 'IE private issue')

    @other_project = Project.generate!(is_public: false, identifier: "ie-other-#{SecureRandom.hex(3)}")
    @other_project.enable_module!(:issue_tracking)
    @foreign_version = Version.create!(project: @other_project, name: 'IE foreign version', status: 'open', sharing: 'none')
    @own_version = Version.create!(project: @project, name: 'IE own version', status: 'open', sharing: 'none')
    @foreign_category = IssueCategory.create!(project: @other_project, name: 'IE foreign category')
  end

  # ── IE-01 the issue must be one the user may see ────────────────────────────

  test 'someone who may edit but cannot see an issue gets "not found" and nothing changes' do
    log_user(@restricted.login)
    put_field(@private_issue, subject: 'IE hacked')
    assert_response :not_found
    assert_equal 'IE private issue', @private_issue.reload.subject

    get "/issues/#{@private_issue.id}/allowed_status", headers: JSON_HEADERS
    assert_response :not_found
    get "/#{@private_issue.id}/check_agile_board_enabled", headers: JSON_HEADERS
    assert_response :not_found
    attachment = Attachment.create!(container: @private_issue, file: uploaded_test_file('testfile.txt', 'text/plain'), author: @author)
    get '/issue_images', params: { issueId: @private_issue.id, imageName: attachment.filename }, headers: JSON_HEADERS
    assert_response :not_found
  end

  test 'someone who can see and edit the issue still gets the same answers' do
    log_user(@editor.login)
    put_field(@private_issue, subject: 'IE edited by editor')
    assert_response :success
    assert_equal 'IE edited by editor', @private_issue.reload.subject
    get "/issues/#{@private_issue.id}/allowed_status", headers: JSON_HEADERS
    assert_response :success
    get "/#{@private_issue.id}/check_agile_board_enabled", headers: JSON_HEADERS
    assert_response :success
  end

  test 'an inline edit writes a journal entry like the normal form' do
    log_user(@editor.login)
    assert_difference -> { @issue.journals.count }, 1 do
      put_field(@issue, subject: 'IE with journal')
    end
    detail = @issue.journals.last.details.detect { |d| d.prop_key == 'subject' }
    assert_equal 'IE with journal', detail.value
  end

  # ── IE-02 the values must pass the same validation as the normal form ───────

  test 'an assignee who cannot be assigned is refused, a project member is accepted' do
    log_user(@editor.login)
    put_field(@issue, assigned_to_id: @outsider.id)
    assert_response :unprocessable_entity
    assert_nil @issue.reload.assigned_to_id
    assert_no_match(/#{Regexp.escape(@outsider.name)}/, response.body)

    put_field(@issue, assigned_to_id: @watcher_only.id)
    assert_response :unprocessable_entity, 'a member whose role cannot be assigned'

    put_field(@issue, assigned_to_id: 99_999_999)
    assert_response :unprocessable_entity

    put_field(@issue, assigned_to_id: @viewer.id)
    assert_response :success
    assert_equal @viewer.id, @issue.reload.assigned_to_id
  end

  test 'a version from a project that is not shared with the issue is refused' do
    log_user(@editor.login)
    put_field(@issue, fixed_version_id: @foreign_version.id)
    assert_response :unprocessable_entity
    assert_nil @issue.reload.fixed_version_id
    assert_no_match(/IE foreign version/, response.body)

    put_field(@issue, fixed_version_id: @own_version.id)
    assert_response :success
    assert_equal @own_version.id, @issue.reload.fixed_version_id
  end

  test 'a category of another project and an out-of-range progress are refused' do
    log_user(@editor.login)
    put_field(@issue, category_id: @foreign_category.id)
    assert_response :unprocessable_entity
    assert_nil @issue.reload.category_id

    put_field(@issue, done_ratio: 5000)
    assert_response :unprocessable_entity
    assert_not_equal 5000, @issue.reload.done_ratio

    put_field(@issue, done_ratio: 40)
    assert_response :success
    assert_equal 40, @issue.reload.done_ratio
  end

  test 'an issue cannot be made its own parent' do
    log_user(@editor.login)
    put_field(@issue, parent_issue_id: @issue.id)
    assert_response :unprocessable_entity
    assert_nil @issue.reload.parent_id
  end

  # ── IE-03 custom field definitions are shown only when the user may see them

  test 'custom fields the user may not see are not listed with their values' do
    hidden = IssueCustomField.create!(name: 'IE hidden field', field_format: 'list', possible_values: ['IE secret value'],
                                      is_for_all: true, visible: false, role_ids: [@not_assignable.id], tracker_ids: Tracker.pluck(:id))
    shown = IssueCustomField.create!(name: 'IE shown field', field_format: 'list', possible_values: ['IE public value'],
                                     is_for_all: true, visible: true, tracker_ids: Tracker.pluck(:id))
    log_user(@editor.login)
    get '/all_custom_fields', headers: JSON_HEADERS
    assert_response :success
    names = JSON.parse(response.body).map { |f| f['name'] }
    assert_includes names, shown.name, 'a visible field is still listed'
    assert_not_includes names, hidden.name
    assert_no_match(/IE secret value/, response.body)
  end

  # ── IE-04 errors ────────────────────────────────────────────────────────────

  test 'an unexpected error does not show its text to the caller' do
    Issue.any_instance.stubs(:save).raises(RuntimeError, 'SECRET-INTERNAL select * from users')
    log_user(@editor.login)
    put_field(@issue, subject: 'IE boom')
    assert_response :internal_server_error
    assert_no_match(/SECRET-INTERNAL|select \* from/, response.body)
  end

  # ── IE-05 api description ───────────────────────────────────────────────────

  test 'the api description and its page need a login, and the address comes from the settings' do
    get '/inplace-issue-editor-api.yaml'
    assert_includes [302, 401], response.status
    get '/inplace_issue_editor/api_doc'
    assert_includes [302, 401], response.status

    log_user(@editor.login)
    get '/inplace-issue-editor-api.yaml', headers: { 'Host' => 'evil.example.org' }
    assert_response :success
    assert_no_match(/evil\.example\.org/, response.body)
  end

  test 'the plugin does not answer every OPTIONS request of Redmine' do
    log_user(@editor.login)
    answered_by = begin
      process :options, "/issues/#{@issue.id}"
      request.path_parameters[:controller]
    rescue ActionController::RoutingError
      nil
    end
    assert_not_equal 'inplace_issue_editor_swagger', answered_by
  end

  # ── IE-06 attachment lookup shows only what the editor needs ────────────────

  test 'the image lookup does not hand out internal attachment fields' do
    attachment = Attachment.create!(container: @issue, file: uploaded_test_file('testfile.txt', 'text/plain'), author: @author)
    log_user(@editor.login)
    get '/issue_images', params: { issueId: @issue.id, imageName: attachment.filename }, headers: JSON_HEADERS
    assert_response :success
    body = JSON.parse(response.body)['attachment']
    assert_equal attachment.id, body['id']
    assert_equal attachment.filename, body['filename']
    %w[disk_filename disk_directory digest author_id].each { |k| assert_not body.key?(k), "#{k} must not be sent" }
  end

  # ── IE-07 lists are for people who can edit ─────────────────────────────────

  test 'member, version and sprint lists are for people who may edit issues or the project' do
    log_user(@viewer.login)
    get "/projects/#{@project.id}/active_members", headers: JSON_HEADERS
    assert_response :forbidden
    get "/#{@project.id}/all_versions", headers: JSON_HEADERS
    assert_response :forbidden

    reset!
    log_user(@editor.login)
    get "/projects/#{@project.id}/active_members", headers: JSON_HEADERS
    assert_response :success
    ids = JSON.parse(response.body)['active_members'].map { |m| m['id'] }
    assert_includes ids, @viewer.id
    assert_not_includes ids, @outsider.id, 'someone who is not a member is not offered'
    get "/#{@project.id}/all_versions", headers: JSON_HEADERS
    assert_response :success
  end

  # ── IE-08 the issue stand-in only offers what it can render ─────────────────

  test 'asking the issue stand-in for journals or allowed statuses gives an answer, not a server error' do
    log_user(@editor.login)
    %w[journals allowed_statuses relations changesets watchers journals,allowed_statuses].each do |inc|
      get "/issues/#{@issue.id}/rf_issue", params: { include: inc }
      assert_response :success, "include=#{inc}"
    end
  end

  # ── IE-09 csrf and api key ──────────────────────────────────────────────────

  test 'a browser session needs the csrf token, an api key without a session does not' do
    ActionController::Base.allow_forgery_protection = true
    log_user(@editor.login)
    put "/issues/#{@issue.id}/update_field", params: { issue: { subject: 'IE forged' } }.to_json, headers: JSON_HEADERS
    assert_response :unprocessable_entity
    assert_not_equal 'IE forged', @issue.reload.subject

    reset!
    put "/issues/#{@issue.id}/update_field", params: { issue: { subject: 'IE by key' } }.to_json, headers: api_headers(@editor)
    assert_response :success
    assert_equal 'IE by key', @issue.reload.subject

    Setting.rest_api_enabled = '0'
    put "/issues/#{@issue.id}/update_field", params: { issue: { subject: 'IE api off' } }.to_json, headers: api_headers(@editor)
    assert_includes [401, 403], response.status
    assert_not_equal 'IE api off', @issue.reload.subject
  ensure
    ActionController::Base.allow_forgery_protection = false
  end

  test 'every endpoint of the plugin needs a login' do
    [
      [:get, "/issues/#{@issue.id}/rf_issue"], [:get, "/projects/#{@project.id}/rf_project"],
      [:put, "/projects/#{@project.id}/rf_project"], [:get, "/projects/#{@project.id}/rf_issue_categories"],
      [:get, '/rf_issue_priorities'], [:get, "/projects/#{@project.id}/active_members"], [:get, "/projects/#{@project.id}/fetch_sprints"],
      [:get, "/issues/#{@issue.id}/allowed_status"], [:put, "/issues/#{@issue.id}/update_field"], [:get, '/all_custom_fields'],
      [:get, '/all_projects'], [:get, "/#{@project.id}/all_versions"], [:get, "/#{@issue.id}/check_agile_board_enabled"],
      [:get, '/agile_story_points'], [:get, '/issue_images']
    ].each do |verb, path|
      process verb, path, headers: JSON_HEADERS
      assert_includes [302, 401, 403], response.status, "#{verb} #{path} answered #{response.status}"
    end
    assert_equal 'IE ordinary issue', @issue.reload.subject
  end

  # ── IE-10 a stale edit does not overwrite silently ──────────────────────────

  test 'an edit made on an outdated copy of the issue is refused and a good edit returns the new version' do
    log_user(@editor.login)
    old_version = @issue.lock_version
    put_field(@issue, subject: 'IE first edit')
    assert_response :success
    assert_equal old_version + 1, JSON.parse(response.body)['issue']['lock_version'], 'the answer carries the new lock version'

    put_field(@issue, subject: 'IE stale edit', lock_version: old_version)
    assert_response :conflict
    assert_equal 'IE first edit', @issue.reload.subject
  end

  # ── IE-11 field level permissions still apply ───────────────────────────────

  test 'a view-only member cannot change anything, a read-only workflow field stays read-only' do
    log_user(@viewer.login)
    put_field(@issue, subject: 'IE viewer edit')
    assert_response :forbidden
    assert_equal 'IE ordinary issue', @issue.reload.subject

    reset!
    WorkflowPermission.create!(tracker_id: @issue.tracker_id, old_status_id: @issue.status_id, role_id: @editor.members.first.roles.first.id,
                               field_name: 'subject', rule: 'readonly')
    log_user(@editor.login)
    put_field(@issue, subject: 'IE locked subject')
    assert_response :forbidden
    assert_equal 'IE ordinary issue', @issue.reload.subject
  end

  test 'a project can only be changed by someone with permission to edit it' do
    log_user(@editor.login)
    put "/projects/#{@project.id}/rf_project", params: { project: { name: 'IE renamed' } }.to_json, headers: JSON_HEADERS
    assert_response :forbidden
    assert_not_equal 'IE renamed', @project.reload.name
    get "/projects/#{@other_project.id}/rf_project", headers: JSON_HEADERS
    assert_response :not_found
  end

  # ── IE-12 script and link output (the editor's JavaScript) ─────────────────

  test 'a stored homepage or link value is never turned into a live script link' do
    core = File.read(File.expand_path('../../assets/javascripts/rf_inline_editor_core.js', __dir__))
    assert_match(/RfIE\.safeUrl\s*=/, core, 'the shared link check exists')
    %w[rf_inline_editor_issue_table rf_inline_editor_project_table].each do |name|
      js = File.read(File.expand_path("../../assets/javascripts/#{name}.js", __dir__))
      assert_no_match(/'<a href="'\s*\+\s*(esc|escHtml)\(/, js, "#{name} builds a link without the scheme check")
      assert_match(/RfIE\.linkHtml\(/, js, "#{name} uses the shared link helper")
    end
  end

  test 'dates and hours shown after a save are escaped, and the base address is not taken from a base tag' do
    table = File.read(File.expand_path('../../assets/javascripts/rf_inline_editor_issue_table.js', __dir__))
    assert_no_match(/return\s+(iso|value|v)\s*\?\s*RfIE\.dateUtils\.toDisplay/, table)
    assert_no_match(/return data\.issue\.estimated_hours_formatted/, table)
    core = File.read(File.expand_path('../../assets/javascripts/rf_inline_editor_core.js', __dir__))
    assert_no_match(/querySelector\('base'\)/, core)
  end

  test 'the texts printed into the page script cannot close the script block' do
    I18n.backend.store_translations(:en, label_rf_saving: 'x</script><img src=x onerror=alert(1)>')
    log_user(@editor.login)
    get "/issues/#{@issue.id}"
    assert_response :success
    assert_no_match(/x<\/script><img src=x/, response.body)
  ensure
    I18n.backend.reload!
  end

  # ── IE-13 odd bodies and values ─────────────────────────────────────────────

  test 'a body that is not shaped like an issue edit gets a clear answer, not a server error' do
    log_user(@editor.login)
    [{ issue: 'text' }, { issue: ['x'] }, { issue: { custom_field_values: 'x' } }, { issue: { custom_field_values: ['x'] } },
     { issue: { status_id: [1, 2] } }, { issue: { subject: { a: 1 } } }].each do |body|
      put "/issues/#{@issue.id}/update_field", params: body.to_json, headers: JSON_HEADERS
      assert_response :unprocessable_entity, body.inspect
    end
    assert_equal 'IE ordinary issue', @issue.reload.subject
  end

  test 'a NUL character in a subject is dropped, a project address with a NUL gets not found' do
    log_user(@editor.login)
    put_field(@issue, subject: "IE nul\u0000subject")
    assert_response :success
    assert_equal 'IE nulsubject', @issue.reload.subject
    get "/projects/%00/active_members", headers: JSON_HEADERS
    assert_response :not_found
    get "/%00/all_versions", headers: JSON_HEADERS
    assert_response :not_found
  end

  test 'a status, tracker, project or priority the user may not set is refused, not silently dropped' do
    log_user(@editor.login)
    put_field(@issue, status_id: 99_999_999)
    assert_response :unprocessable_entity
    put_field(@issue, tracker_id: 99_999_999)
    assert_response :unprocessable_entity
    put_field(@issue, project_id: @other_project.id)
    assert_response :unprocessable_entity
    assert_equal @project.id, @issue.reload.project_id
    # asking for the value the issue already has is not an error
    put_field(@issue, status_id: @issue.status_id, subject: 'IE same status')
    assert_response :success
  end

  # ── IE-14 notifications like the normal form ────────────────────────────────

  test 'an inline edit leaves a journal that notifies the same people as the normal form, and not people who cannot see the issue' do
    Setting.notified_events = Setting.notified_events.to_a | ['issue_updated']
    @author.update_columns(mail_notification: 'all')
    @outsider.update_columns(mail_notification: 'all')
    log_user(@editor.login)
    put_field(@private_issue, subject: 'IE notify check')
    assert_response :success
    journal = @private_issue.reload.journals.order(:id).last
    assert_equal @editor.id, journal.user_id
    notified = journal.notified_users
    assert_includes notified, @author, 'the author of the issue is told'
    assert_not_includes notified, @outsider, 'someone who cannot see the private issue is not told'
    # Redmine sends the mail from the journal's after-commit hook; it is sent for this journal like for any other.
    assert journal.send(:notify?), 'the journal is one that Redmine mails'
  end

  # ── IE-15 what the editor shows after a save, and HTML copied back into the page ──

  test 'a project custom field is shown from a fresh read of the project, not from what was typed' do
    table = File.read(File.expand_path('../../assets/javascripts/rf_inline_editor_project_table.js', __dir__))
    assert_no_match(/optimisticDisplay\(value\);/, table, 'the table no longer falls back to the typed value')
    card = File.read(File.expand_path('../../assets/javascripts/rf_inline_editor_project_card.js', __dir__))
    assert_match(/rf_project'\);\s*\}\)\.then\(function \(fresh\)/, card, 'the card re-reads the project after the save')
    assert_match(/resolveDisplayVal\(cf, stored\.value, ident\)/, card)
  end

  test 'server html copied into the open page loses handlers that fire by themselves' do
    core = File.read(File.expand_path('../../assets/javascripts/rf_inline_editor_core.js', __dir__))
    assert_match(/RfIE\.sanitizeDoc\s*=/, core)
    show = File.read(File.expand_path('../../assets/javascripts/rf_inline_editor_issue_show.js', __dir__))
    assert_equal 0, show.scan(/new DOMParser\(\)\.parseFromString\(html, 'text\/html'\)(?!\))/).size, 'a parsed copy is used without the sanitizer'
    assert_operator show.scan('RfIE.sanitizeDoc(').size, :>=, 3
  end

  private

  def put_field(issue, attrs)
    put "/issues/#{issue.id}/update_field", params: { issue: attrs }.to_json, headers: JSON_HEADERS
  end

  def log_user(login)
    get '/login'
    token = css_select('input[name=authenticity_token]').first&.[]('value')
    post '/login', params: { username: login, password: @password, authenticity_token: token }.compact
    follow_redirect!
  end

  def make_user(login)
    user = User.generate!(login: login)
    user.password = user.password_confirmation = @password
    user.save!
    user
  end

  def api_headers(user)
    JSON_HEADERS.merge('X-Redmine-API-Key' => user.api_key)
  end
end
