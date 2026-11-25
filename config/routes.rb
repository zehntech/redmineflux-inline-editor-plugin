# RF Inline Editor — Plugin Routes
# All routes are scoped under the standard Redmine URL space.

# Deliberately no `defaults: { format: :json }` on these routes, and the editor
# does not put `.json` on the URLs either. Redmine's find_current_user skips the
# session entirely for any request whose format is json or xml, accepting only an
# API key or HTTP Basic - so a route declared as JSON can never be authenticated
# by the signed-in user's session. These actions render JSON explicitly, which
# works regardless of the request format. See #121123.
# Stand-ins for the parts of Redmine's own REST API the editor needs, so that a
# browser session can authenticate them - see the note in the controller.
get '/issues/:id/rf_issue',                to: 'issue_tables#rf_issue'
get '/projects/:id/rf_project',            to: 'issue_tables#rf_project'
put '/projects/:id/rf_project',            to: 'issue_tables#rf_update_project'
get '/projects/:id/rf_issue_categories',   to: 'issue_tables#rf_issue_categories'
get '/rf_issue_priorities',                to: 'issue_tables#rf_issue_priorities'

# Project members for inline assignee dropdown
get '/projects/:id/active_members',       to: 'issue_tables#fetch_active_members'

# Sprints for a project (proxy — agile plugin API requires API-key auth, we use session auth)
get '/projects/:id/fetch_sprints',        to: 'issue_tables#fetch_sprints'

# Workflow-allowed statuses for an issue
get '/issues/:id/allowed_status',          to: 'issue_tables#fetch_issue_allowed_status'

# Partial inline update — bypasses unrelated required-field validations
put '/issues/:id/update_field',            to: 'issue_tables#update_issue_field'

# Custom field definitions
get '/all_custom_fields',                  to: 'issue_tables#all_custom_fields'

# All projects (for project field searchable dropdown)
get '/all_projects',                       to: 'issue_tables#all_projects'

# Open versions shared with a project
get '/:id/all_versions',                   to: 'issue_tables#all_versions'

# Agile board plugin detection
get '/:id/check_agile_board_enabled',      to: 'issue_tables#check_agile_board_enabled'

# Agile story point values from plugin settings (no endpoint in agile plugin itself)
get '/agile_story_points',                 to: 'issue_tables#agile_story_points'

# Attachment lookup for description image rendering
get '/issue_images',                       to: 'issue_tables#issue_images'

# Swagger API documentation
get  '/inplace_issue_editor/api_doc',      to: 'inplace_issue_editor_swagger#index'
get  '/inplace-issue-editor-api.yaml',     to: 'inplace_issue_editor_swagger#swagger',
                                           defaults: { format: :yaml }
# Only the two documentation addresses answer a preflight. (A catch-all `*path` used to answer every
# OPTIONS request of the whole Redmine, other plugins' included.)
match '/inplace_issue_editor/api_doc',  to: 'inplace_issue_editor_swagger#preflight', via: :options
match '/inplace-issue-editor-api.yaml', to: 'inplace_issue_editor_swagger#preflight', via: :options
