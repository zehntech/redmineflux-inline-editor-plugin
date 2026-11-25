class EditorHooks < Redmine::Hook::ViewListener
  # The description editor does not build its own formatting toolbar - it picks
  # up the one Redmine has already built for the issue's own edit form and moves
  # it into place. That form is the only thing that makes description editing
  # possible here at all, so wherever this plugin can edit a description,
  # Redmine has already loaded jstoolbar itself.
  #
  # This class used to load jstoolbar again from the page <head> regardless. On
  # the issue page that meant two copies of the same core scripts, and the second
  # copy failed with "Identifier 'lastJstPreviewed' has already been declared" on
  # every page load - see #121124. Leave the loading to Redmine; putting it back
  # here brings the duplicate back with it.

  # Inject plugin stylesheet + all module scripts at the bottom of <body>.
  # Config (canEditIssues / canEditProjects) is set per-page by _rf_header_assets.html.erb.
  # We load scripts for any logged-in user because:
  #   - project listing has no context[:project] even when the user is a project manager.
  #   - each JS module guards itself using RfIE.config.canEditIssues / canEditProjects.
  def view_layouts_base_body_bottom(context)
    return '' unless User.current.logged?

    content = stylesheet_link_tag('rf_inline_editor.css', plugin: :inplace_issue_editor)

    # Load all modules — each guards itself with the relevant permission flag
    content << javascript_include_tag('rf_inline_editor_core.js',          plugin: :inplace_issue_editor)
    content << javascript_include_tag('rf_inline_editor_issue_show.js',    plugin: :inplace_issue_editor)
    content << javascript_include_tag('rf_inline_editor_issue_table.js',   plugin: :inplace_issue_editor)
    content << javascript_include_tag('rf_inline_editor_project_table.js', plugin: :inplace_issue_editor)
    content << javascript_include_tag('rf_inline_editor_project_card.js',  plugin: :inplace_issue_editor)

    # Prevent accidental double-click on logout link while an edit is in progress
    content << javascript_tag(<<~JS)
      document.addEventListener('DOMContentLoaded', function() {
        var logoutLink = document.querySelector('.logout');
        if (logoutLink) {
          logoutLink.addEventListener('click', function() {
            this.dataset.rfClicked = '1';
            this.style.pointerEvents = 'none';
          });
        }
      });
    JS

    content.html_safe
  end
end
