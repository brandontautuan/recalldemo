# Local Private Repository Context

## Status

Implemented for explicit documentation files. This document defines the boundary for future local source-code retrieval.

## Product decision

Repository context is read directly from local repositories mounted or checked out on the application server. It does not use GitHub, a remote repository API, a personal-access token, an OAuth flow, or a browser credential.

## Current workflow

```text
Server allowlists repository parent directories
  → User configures an absolute repository path and explicit relative docs paths
  → Backend resolves real paths and scans bounded files
  → User reviews and approves the immutable ingestion
  → User previews and approves meeting-specific context
  → Explicit analysis receives only that approved snapshot
```

`PROJECT_REPOSITORY_ROOTS` is the server-side path allowlist. `PROJECT_CONTEXT_ADMIN_TOKEN` protects configuration, scan, ingestion inspection, and approval. The browser never receives a configured absolute path; Groq never gets filesystem access or unapproved content.

The scanner permits only explicit `.md`, `.mdx`, `.rst`, and `.txt` files today. It rejects path traversal, symlinks, files outside allowed roots, secret-like names, ignored dependency/build directories, oversized content, and empty input. It records paths, bounded line ranges, content hashes, tracked paths, a working-tree fingerprint, and Git `HEAD` when available. Any source change blocks new previews and analysis until a new scan is approved.

## Next scope: local focused code

The next phase may extend this same adapter to explicitly selected safe source files. It must retain the current path and content protections, split files into line-addressable chunks, label any bounded relative-import neighbor with its inclusion reason, and require ingestion review before a chunk can be selected. The model must not browse the filesystem or expand scope.

## Later scope: local deep-codebase retrieval

A later phase can build a bounded map and chunk index for one local commit, then rank chunks deterministically from the transcript, approved notes, paths, symbols, and imports. Hard caps for files, bytes, chunks, and final model input apply. The context preview must explain included and omitted chunks. Do not add embeddings until deterministic retrieval has been measured against manual-transcript fixtures.

## Non-goals

Remote repository connections, GitHub, source-code write access, automatic cloning, arbitrary filesystem paths, autonomous follow-up retrieval, full repository prompts, pull requests, issues, and ticket submission are out of scope.
