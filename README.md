# Network Recorder

Browser extension for capturing network activity in Chromium-based browsers.

## Repository role

This repository owns the source code, versioning, signing workflow and GitHub Releases for **Network Recorder**.

It intentionally does **not** contain a separate Project Manager or Context Capsule at this stage. Ecosystem coordination is currently handled by `extension-installer-project-manager` in `lvlaksim1/extension-installer`.

## Signing policy

- The RSA private signing key must never be committed to Git.
- The signing key will be stored in GitHub Actions secret/environment scope.
- Release builds are signed in GitHub CI.
- The local ExtensionInstaller consumes already signed CRX releases and does not require the private key.
- The existing stable Extension ID must be preserved when the current key is migrated to GitHub secret scope.

## Release/storage policy

- Source code and build/release scripts belong in Git.
- CRX/ZIP distributables belong in GitHub Releases.
- GitHub Actions artifacts are not used as long-term release storage.
- Temporary build outputs remain ephemeral.

## Current onboarding state

The repository has been created and secured against accidental key/binary commits. The retained stable Network Recorder v1.6.0 source will be onboarded next, followed by GitHub-side signing and the first signed release for ExtensionInstaller integration.
