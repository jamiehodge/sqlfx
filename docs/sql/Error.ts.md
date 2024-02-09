---
title: Error.ts
nav_order: 3
parent: "@sqlfx/sql"
---

## Error overview

Added in v1.0.0

---

<h2 class="text-delta">Table of contents</h2>

- [constructor](#constructor)
  - [ResultLengthMismatch](#resultlengthmismatch)
  - [SchemaError](#schemaerror)
  - [SqlError](#sqlerror)
- [model](#model)
  - [ResultLengthMismatch (interface)](#resultlengthmismatch-interface)
  - [SchemaError (interface)](#schemaerror-interface)
- [utils](#utils)
  - [SqlError (interface)](#sqlerror-interface)
  - [SqlFxErrorId](#sqlfxerrorid)
  - [SqlFxErrorId (type alias)](#sqlfxerrorid-type-alias)

---

# constructor

## ResultLengthMismatch

**Signature**

```ts
export declare const ResultLengthMismatch: (expected: number, actual: number) => ResultLengthMismatch
```

Added in v1.0.0

## SchemaError

**Signature**

```ts
export declare const SchemaError: (type: SchemaError["type"], error: ParseIssue) => SchemaError
```

Added in v1.0.0

## SqlError

**Signature**

```ts
export declare const SqlError: (message: string, error: unknown) => SqlError
```

Added in v1.0.0

# model

## ResultLengthMismatch (interface)

**Signature**

```ts
export interface ResultLengthMismatch {
  readonly [SqlFxErrorId]: SqlFxErrorId
  readonly _tag: "ResultLengthMismatch"
  readonly expected: number
  readonly actual: number
}
```

Added in v1.0.0

## SchemaError (interface)

**Signature**

```ts
export interface SchemaError {
  readonly [SqlFxErrorId]: SqlFxErrorId
  readonly _tag: "SchemaError"
  readonly type: "request" | "result"
  readonly error: ParseIssue
}
```

Added in v1.0.0

# utils

## SqlError (interface)

**Signature**

```ts
export interface SqlError {
  readonly [SqlFxErrorId]: SqlFxErrorId
  readonly _tag: "SqlError"
  readonly message: string
  readonly code?: string
  readonly error: unknown
}
```

Added in v1.0.0

## SqlFxErrorId

**Signature**

```ts
export declare const SqlFxErrorId: typeof SqlFxErrorId
```

Added in v1.0.0

## SqlFxErrorId (type alias)

**Signature**

```ts
export type SqlFxErrorId = typeof SqlFxErrorId
```

Added in v1.0.0
