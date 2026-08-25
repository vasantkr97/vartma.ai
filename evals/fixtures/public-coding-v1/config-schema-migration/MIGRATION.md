# Configuration migration

Version 1 has `{version, model, apiKeyEnv, metadata}`. Version 2 has
`{version: 2, routing: {defaultModel, mode}, providers: {default: {credentialEnv}}, metadata}`.
Migrate v1 using mode `balanced`, preserve unknown metadata deeply, never mutate input, return an
independent clone for v2 input, and reject every other version. Applying migration repeatedly must
be idempotent.
