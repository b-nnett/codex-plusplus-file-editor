# File Editor

Makes Codex right-panel file tabs editable.

## Features

- Replaces the read-only code pane with an editable local text editor.
- Autosaves after an idle backoff delay.
- Retries failed autosaves with exponential backoff.
- Detects on-disk mtime conflicts before writing.
- Supports manual save, force save after conflict, and reload from disk.