module Timer
  class TimerHooks < Redmine::Hook::ViewListener
    # Inject config and scripts into <head> of every page
    render_on :view_layouts_base_html_head, partial: 'issues/rf_header_assets'

    # Inject description editor support on the issue show page
    render_on :view_issues_show_details_bottom, partial: 'issues/rf_assets'
  end
end
