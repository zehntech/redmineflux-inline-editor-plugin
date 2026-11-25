# Placeholder — Redmine 7.x line (`release/7.0.0`)

This branch is an **empty placeholder** created by the plugin branch-standardisation
rollout. Every plugin should have one branch per supported Redmine major
(`release/5.0.0` / `release/6.0.0` / `release/7.0.0`). This slot is empty because
there is no verified Redmine 7.x build of this plugin yet.

## It needs to be filled with the Redmine 7.x build of this plugin

How to fill it:
1. `git fetch origin && git checkout release/7.0.0`
2. Bring in the plugin code as the Redmine 7 base. Best source, in order:
   - the archived `redmineflux-<this-plugin>-v7` repo if one exists (that is the real Redmine 7 code), or
   - this plugin's `master`, adapted to run on Redmine 7.
   (e.g. `git checkout master -- .` then make the Redmine 7 compatibility changes.)
3. Set the `version` constant in `init.rb` to the 7.x version.
4. Verify it installs and the tests pass on a Redmine 7 instance — test as a
   non-admin user too, not only admin.
5. Commit and push this branch.

Do not leave this branch empty. If this plugin does **not** support Redmine 7,
tell the leads so we delete this branch instead.

Convention: `branch-rollout/BRANCHING-CONVENTION.md` in `redmineflux-commercial`.
