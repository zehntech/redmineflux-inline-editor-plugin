class InplaceIssueEditorSwaggerController < ApplicationController
  # The API description and its page need a login like the rest of Redmine (they used to be public, which
  # told anyone on the internet what endpoints exist). Only the empty preflight answer stays open.
  skip_before_action :check_if_login_required, only: [:preflight]
  before_action :require_login, only: [:index, :swagger]

  def preflight
    head :ok
  end

  def index
    render html: '', layout: 'inplace_issue_editor_swagger_layout', content_type: 'text/html'
  end

  def swagger
    yaml_file = Rails.root.join('plugins', 'inplace_issue_editor', 'assets', 'swagger', 'inplace_issue_editor_swagger.yaml')

    if File.exist?(yaml_file)
      yaml_content = File.read(yaml_file)
      # The address comes from Redmine's own settings, not from the Host header the caller sent (a forged
      # Host header must not be able to put another server into the "try it out" address).
      server_url = "#{Setting.protocol}://#{Setting.host_name}".chomp('/')
      yaml_content.gsub!("{server_url}", server_url)
      render plain: yaml_content, content_type: 'application/x-yaml'
    else
      render plain: "inplace_issue_editor_swagger.yaml not found", status: 404
    end
  end
end
