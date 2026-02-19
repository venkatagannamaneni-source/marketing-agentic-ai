# CLAUDE.md

## Project Overview

**marketing-agentic-ai** is an agentic AI system designed to function as a full marketing team. It strategizes, writes, optimizes, and audits marketing content — powered by Claude with 24 specialized marketing skills.

## Current State

This project is in the **early initialization phase**. The repository currently contains only a README.md with the project description. No source code, configuration files, dependencies, or infrastructure have been established yet.

### Repository Contents

```
marketing-agentic-ai/
├── .git/
├── README.md          # Project description
└── CLAUDE.md          # This file
```

## Project Vision

The system aims to provide 24 specialized marketing capabilities through an agentic AI architecture, including (but not limited to):
- Marketing strategy development
- Content writing and generation
- SEO optimization
- Content auditing and analysis
- Campaign planning and execution

## Development Guidelines

### For AI Assistants

When working on this repository:

1. **Technology stack is not yet decided.** If asked to implement features, confirm the intended stack (e.g., Python, Node.js/TypeScript) with the user before proceeding.
2. **No build system exists yet.** Any implementation work should start by establishing project scaffolding (package manager, dependencies, project structure).
3. **No tests exist yet.** When adding code, also add corresponding tests and a test framework configuration.
4. **No linting/formatting is configured.** When establishing the codebase, set up linting and formatting tools appropriate to the chosen language.
5. **No CI/CD pipelines exist.** Consider adding GitHub Actions workflows when the project reaches a point where automated checks are valuable.

### Conventions to Follow

- **Commit messages**: Use clear, descriptive commit messages. Prefer conventional commit format (e.g., `feat:`, `fix:`, `docs:`, `chore:`).
- **Branch naming**: Feature branches should use descriptive names (e.g., `feat/content-writer-skill`, `fix/strategy-output-format`).
- **Documentation**: Update this CLAUDE.md and README.md as the project evolves. Keep documentation in sync with actual project state.
- **Code organization**: When source code is added, organize by feature/skill rather than by technical layer where practical.
- **Environment variables**: Never commit secrets or API keys. Use `.env` files (gitignored) and provide `.env.example` templates.

### Key Decisions Still Needed

- Programming language and runtime
- Package manager and dependency management approach
- Project structure and module organization
- API design (if applicable — REST, GraphQL, CLI, SDK)
- How the 24 marketing skills are defined, registered, and orchestrated
- Storage and state management strategy
- Deployment target and infrastructure

## Common Commands

_No commands are configured yet. This section will be updated as the project develops._

## Architecture

_Architecture has not been defined yet. This section will be updated when implementation begins._
