Release a new version of the plugin to npm via GitHub Releases.

Requires an argument for the version bump type: `patch`, `minor`, or `major`. If no argument is provided, stop and ask the user which bump type they want.

Follow these steps in order, stopping immediately if any step fails:

## 1. Pre-flight checks

- If `$ARGUMENTS` is empty, stop and ask the user: "Which version bump? (`patch`, `minor`, or `major`)"
- Verify the git working tree is clean (`git status --porcelain` should be empty). If not, stop and tell the user to commit or stash changes first.
- Verify we're on the `main` branch.
- Run `npm run lint`, `npm run build`, and `npm test`. If any fail, stop.

## 2. Bump version

- Run `npm version $ARGUMENTS`. This updates package.json, creates a commit, and creates a git tag.
- Read back the new version from package.json.

## 3. Push to GitHub

- Run `git push && git push --tags` to push the version commit and tag.

## 4. Generate release notes

Generate user-friendly release notes for Homebridge users. These notes appear in the Homebridge UI when users check for plugin updates, so they should be concise and describe **what changed for the user** (not internal code details).

To do this:
- Run `git log <previous-tag>..HEAD --oneline` to see commits since the last release.
- Write a short markdown body with a `## What's Changed` section containing a bulleted list summarizing the changes. Combine related commits into single bullet points. Focus on user-visible behavior changes, bug fixes, and new features. Skip purely internal changes (CI, refactoring, tests) unless they're the only changes — in that case mention them briefly.
- Append a Full Changelog link: `**Full Changelog**: https://github.com/rowofpixels/homebridge-smartlight-ac/compare/<previous-tag>...<new-tag>`

## 5. Create GitHub Release

- Create the release using `gh release create <new-tag> --title <new-tag> --notes <body>` with the generated notes.
- This triggers the publish workflow which pushes to npm automatically.

## 6. Confirm

Print the release URL and the new version number so the user can verify.
