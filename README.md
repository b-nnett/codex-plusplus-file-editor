# File Editor

<img width="2000" height="1468" alt="Screen Recording 2026-05-02 at 19 27 01 smaller" src="https://github.com/user-attachments/assets/88eda2ff-f9b2-4c49-831c-eb443cc799b7" />

File Editor is a Codex++ tweak that turns Codex's right-panel file preview into an editable local text editor.

It keeps the native right-panel flow, but overlays an editor with syntax highlighting, line numbers, autosave controls, breadcrumb navigation, and local file actions.

## Features

- Edit local text files directly from the Codex right panel.
- Save manually with `Cmd+S` / `Ctrl+S`.
- Store autosaved drafts locally by default, with an optional setting to write idle autosaves to disk.
- Detect on-disk modification conflicts before writing.
- Retry failed disk autosaves with exponential backoff.
- Reload or force-save after conflict.
- Browse parent folders from the breadcrumb menu.
- Copy paths and open files or folders in Finder/File Explorer.
- Create new files and folders from the workspace file tree.
- Add review comments from selected editor lines when the diff comment bridge is available.
- Highlight common file types, including JavaScript/TypeScript, JSON, CSS, markup, shell, Python, and Markdown.
- Follow Codex light and dark themes for the editor background and token colors.

## Installation

Copy this folder into your Codex++ tweaks directory:

```text
~/Library/Application Support/codex-plusplus/tweaks/co.bennett.file-editor
```

Then restart Codex, or reload Codex++ tweaks if your runtime supports hot reload.

## Usage

Open a file in Codex's right panel. If the file is a local UTF-8 text file under the size limit, File Editor replaces the read-only preview with an editable editor.

The File Editor settings page controls autosave behavior:

- Enable autosave: saves local drafts after the editor is idle.
- Write autosaves to disk: writes idle autosaves directly to the file.
- Autosave backoff: controls the idle delay before saving.

Manual save always writes to disk.

## Limits

- Binary files are not editable.
- Files larger than 5 MB are rejected.
- Syntax highlighting is lightweight and regex-based. It is intended for readability, not full language-server accuracy.

## Release

Current release: `v0.1.0`

## License

No license has been declared yet.
