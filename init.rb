if Redmine::VERSION::MAJOR == 4
  require_relative './lib/editor_hooks.rb'
  require_relative './lib/timer/timer_hooks.rb'
elsif Redmine::VERSION::MAJOR >= 5
  require File.expand_path('./lib/editor_hooks.rb', __dir__)
  require File.expand_path('./lib/timer/timer_hooks.rb', __dir__)
end

Redmine::Plugin.register :inplace_issue_editor do
  name        'Redmineflux Inline Issue Editor plugin'
  author      'Redmineflux — Powered by Zehntech Technologies Inc.'
  description 'Professional inline editing for Redmine issues, projects, and custom fields. ' \
              'Supports issue list, issue detail, project table, and project card views with ' \
              'clean searchable dropdowns, permission-aware controls, and zero layout disruption.'
  version     '5.0.0'
  url         'https://www.redmineflux.com/knowledge-base/plugins/inline-editor-plugin/'
  author_url  'https://www.redmineflux.com'
  settings partial: 'settings/blank_pages'
end
