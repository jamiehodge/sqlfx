import * as Schema from "@effect/schema/Schema"
import * as Context from "effect/Context"
import { GenericTag } from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FiberRef from "effect/FiberRef"
import { pipe } from "effect/Function"
import * as Option from "effect/Option"
import * as ROA from "effect/ReadonlyArray"
import * as request from "effect/Request"
import * as RequestResolver from "effect/RequestResolver"
import type { Client, Request, Resolver } from "../Client.js"
import type { Connection } from "../Connection.js"
import type { SchemaError, SqlError } from "../Error.js"
import { ResultLengthMismatch } from "../Error.js"
import * as SqlSchema from "../Schema.js"
import * as Statement from "../Statement.js"

/** @internal */
export const TransactionConn = GenericTag<
  readonly [conn: Connection, counter: number]
>("@services/TransactionConn")

/** @internal */
export function make({
  acquirer,
  beginTransaction = "BEGIN",
  commit = "COMMIT",
  compiler,
  rollback = "ROLLBACK",
  rollbackSavepoint = _ => `ROLLBACK TO SAVEPOINT ${_}`,
  savepoint = _ => `SAVEPOINT ${_}`,
  transactionAcquirer,
}: Client.MakeOptions): Client {
  const getConnection = Effect.flatMap(
    Effect.serviceOption(TransactionConn),
    Option.match({
      onNone: () => acquirer,
      onSome: ([conn]) => Effect.succeed(conn),
    }),
  )
  const withTransaction = <R, E, A>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | SqlError, R> =>
    Effect.scoped(
      Effect.acquireUseRelease(
        pipe(
          Effect.serviceOption(TransactionConn),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.map(transactionAcquirer, conn => [conn, 0] as const),
              onSome: ([conn, count]) =>
                Effect.succeed([conn, count + 1] as const),
            }),
          ),
          Effect.tap(([conn, id]) =>
            id > 0
              ? conn.executeRaw(savepoint(`sqlfx${id}`))
              : conn.executeRaw(beginTransaction),
          ),
        ),
        ([conn, id]) =>
          Effect.provideService(effect, TransactionConn, [conn, id]),
        ([conn, id], exit) =>
          Exit.isSuccess(exit)
            ? id > 0
              ? Effect.unit
              : Effect.orDie(conn.executeRaw(commit))
            : id > 0
              ? Effect.orDie(conn.executeRaw(rollbackSavepoint(`sqlfx${id}`)))
              : Effect.orDie(conn.executeRaw(rollback)),
      ),
    )

  function schema<IR, II, IA, AR, AI, A, R, E>(
    requestSchema: Schema.Schema<IA, II, IR>,
    resultSchema: Schema.Schema<A, AI, AR>,
    run: (_: II) => Effect.Effect<ReadonlyArray<unknown>, E, IR | AR | R>,
  ) {
    const decodeResult = SqlSchema.decodeUnknown(
      Schema.array(resultSchema),
      "result",
    )
    const encodeRequest = SqlSchema.encode(requestSchema, "request")

    return (
      _: IA,
    ): Effect.Effect<ReadonlyArray<A>, SchemaError | E, IR | AR | R> =>
      pipe(encodeRequest(_), Effect.flatMap(run), Effect.flatMap(decodeResult))
  }

  function schemaVoid<IR, II, IA, R, E>(
    requestSchema: Schema.Schema<IA, II, IR>,
    run: (_: II) => Effect.Effect<unknown, E, R>,
  ) {
    const encodeRequest = SqlSchema.encode(requestSchema, "request")
    return (_: IA): Effect.Effect<void, SchemaError | E, IR | R> =>
      Effect.asUnit(Effect.flatMap(encodeRequest(_), run))
  }

  function schemaSingle<IR, II, IA, AR, AI, A, R, E>(
    requestSchema: Schema.Schema<IA, II, IR>,
    resultSchema: Schema.Schema<A, AI, AR>,
    run: (_: II) => Effect.Effect<ReadonlyArray<unknown>, E, R>,
  ) {
    const decodeResult = SqlSchema.decodeUnknown(resultSchema, "result")
    const encodeRequest = SqlSchema.encode(requestSchema, "request")

    return (_: IA): Effect.Effect<A, SchemaError | E, IR | AR | R> =>
      pipe(
        encodeRequest(_),
        Effect.flatMap(run),
        Effect.flatMap(_ => Effect.orDie(ROA.head(_))),
        Effect.flatMap(decodeResult),
      )
  }

  function schemaSingleOption<IR, II, IA, AR, AI, A, R, E>(
    requestSchema: Schema.Schema<IA, II, IR>,
    resultSchema: Schema.Schema<A, AI, AR>,
    run: (_: II) => Effect.Effect<ReadonlyArray<unknown>, E, R>,
  ) {
    const decodeResult = SqlSchema.decodeUnknown(resultSchema, "result")
    const encodeRequest = SqlSchema.encode(requestSchema, "request")

    return (
      _: IA,
    ): Effect.Effect<Option.Option<A>, SchemaError | E, IR | AR | R> =>
      pipe(
        encodeRequest(_),
        Effect.flatMap(run),
        Effect.map(ROA.head),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeedNone,
            onSome: result => Effect.asSome(decodeResult(result)),
          }),
        ),
      )
  }

  const makeExecuteRequest =
    <E, A, RA>(
      Request: request.Request.Constructor<
        request.Request<A, SchemaError | E> & { i0: RA }
      >,
    ) =>
    (
      Resolver: RequestResolver.RequestResolver<any, any>,
      context = Context.empty() as Context.Context<any>,
    ) => {
      const resolverWithSql = Effect.map(
        Effect.serviceOption(TransactionConn),
        _ =>
          RequestResolver.provideContext(
            Resolver,
            Option.match(_, {
              onNone: () => context,
              onSome: tconn => Context.add(context, TransactionConn, tconn),
            }),
          ),
      )
      return (i0: RA) =>
        Effect.flatMap(resolverWithSql, resolver =>
          Effect.request(Request({ i0 }), resolver),
        )
    }

  const makePopulateCache =
    <E, A, RA>(
      Request: request.Request.Constructor<
        request.Request<A, SchemaError | E> & { i0: RA }
      >,
    ) =>
    (id: RA, _: A) =>
      Effect.cacheRequestResult(Request({ i0: id }), Exit.succeed(_))

  const makeInvalidateCache =
    <E, A, RA>(
      Request: request.Request.Constructor<
        request.Request<A, SchemaError | E> & { i0: RA }
      >,
    ) =>
    (id: RA) =>
      Effect.flatMap(FiberRef.get(FiberRef.currentRequestCache), cache =>
        cache.invalidate(Request({ i0: id })),
      )

  function resolverSingleOption<T extends string, R, IR, II, IA, AR, AI, A, E>(
    tag: T,
    options: {
      readonly request: Schema.Schema<IA, II, IR>
      readonly result: Schema.Schema<A, AI, AR>
      readonly run: (request: II) => Effect.Effect<ReadonlyArray<unknown>, E, R>
    },
  ): Resolver<T, R | IR | AR, IA, Option.Option<A>, E> {
    const Request = request.tagged<Request<T, IA, E, Option.Option<A>>>(tag)
    const encodeRequest = SqlSchema.encode(options.request, "request")
    const decodeResult = SqlSchema.decodeUnknown(options.result, "result")
    const Resolver = RequestResolver.fromEffect(
      (req: Request<T, IA, E, Option.Option<A>>) =>
        pipe(
          encodeRequest(req.i0),
          Effect.flatMap(options.run),
          Effect.map(ROA.head),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeedNone,
              onSome: result => Effect.asSome(decodeResult(result)),
            }),
          ),
        ),
    )

    const makeExecute = makeExecuteRequest(Request)
    const execute = makeExecute(Resolver as any)
    const populateCache = makePopulateCache(Request)
    const invalidateCache = makeInvalidateCache(Request)

    return {
      Request,
      Resolver,
      execute,
      makeExecute,
      populateCache,
      invalidateCache,
    } as any
  }

  function resolverSingle<T extends string, R, IR, II, IA, AR, AI, A, E>(
    tag: T,
    options: {
      readonly request: Schema.Schema<IA, II, IR>
      readonly result: Schema.Schema<A, AI, AR>
      readonly run: (request: II) => Effect.Effect<ReadonlyArray<unknown>, E, R>
    },
  ): Resolver<T, R | IR | AR, IA, A, E> {
    const Request = request.tagged<Request<T, IA, E, A>>(tag)
    const encodeRequest = SqlSchema.encode(options.request, "request")
    const decodeResult = SqlSchema.decodeUnknown(options.result, "result")
    const Resolver = RequestResolver.fromEffect((req: Request<T, IA, E, A>) =>
      pipe(
        encodeRequest(req.i0),
        Effect.flatMap(options.run),
        Effect.flatMap(_ => Effect.orDie(ROA.head(_))),
        Effect.flatMap(decodeResult),
      ),
    )

    const makeExecute = makeExecuteRequest(Request)
    const execute = makeExecute(Resolver)
    const populateCache = makePopulateCache(Request)
    const invalidateCache = makeInvalidateCache(Request)

    return {
      Request,
      Resolver,
      execute,
      makeExecute,
      populateCache,
      invalidateCache,
    } as any
  }

  function resolverVoid<T extends string, R, IR, II, IA, E>(
    tag: T,
    options: {
      readonly request: Schema.Schema<IA, II, IR>
      readonly run: (
        requests: ReadonlyArray<II>,
      ) => Effect.Effect<unknown, E, R>
    },
  ): Resolver<T, R | IR, IA, void, E> {
    const Request = request.tagged<Request<T, IA, E, void>>(tag)
    const encodeRequests = SqlSchema.encode(
      Schema.array(options.request),
      "request",
    )
    const Resolver = RequestResolver.makeBatched(
      (requests: Array<Request<T, IA, E, void>>) =>
        pipe(
          encodeRequests(requests.map(_ => _.i0)),
          Effect.flatMap(options.run),
          Effect.zipRight(
            Effect.forEach(
              requests,
              req => request.succeed(req, void 0 as any),
              { discard: true },
            ),
          ),
          Effect.catchAll(error =>
            Effect.forEach(requests, req => request.fail(req, error), {
              discard: true,
            }),
          ),
        ),
    )

    const makeExecute = makeExecuteRequest(Request)
    const execute = makeExecute(Resolver)
    const populateCache = makePopulateCache(Request)
    const invalidateCache = makeInvalidateCache(Request)

    return {
      Request,
      Resolver,
      execute,
      makeExecute,
      populateCache,
      invalidateCache,
    } as any
  }
  function resolver<T extends string, R, IR, II, IA, AR, AI, A, E>(
    tag: T,
    options: {
      readonly request: Schema.Schema<IA, II, IR>
      readonly result: Schema.Schema<A, AI, AR>
      readonly run: (
        requests: ReadonlyArray<II>,
      ) => Effect.Effect<ReadonlyArray<unknown>, E, R>
    },
  ): Resolver<T, R | IR | AR, IA, A, E | ResultLengthMismatch> {
    const Request =
      request.tagged<Request<T, IA, E | ResultLengthMismatch, A>>(tag)
    const encodeRequests = SqlSchema.encode(
      Schema.array(options.request),
      "request",
    )
    const decodeResult = SqlSchema.decodeUnknown(options.result, "result")
    const Resolver = RequestResolver.makeBatched(
      (requests: Array<Request<T, IA, E | ResultLengthMismatch, A>>) =>
        pipe(
          encodeRequests(requests.map(_ => _.i0)),
          Effect.flatMap(options.run),
          Effect.filterOrFail(
            results => results.length === requests.length,
            _ => ResultLengthMismatch(requests.length, _.length),
          ),
          Effect.flatMap(results =>
            Effect.forEach(results, (result, i) =>
              pipe(
                decodeResult(result),
                Effect.flatMap(result => request.succeed(requests[i], result)),
                Effect.catchAll(error =>
                  request.fail(requests[i], error as any),
                ),
              ),
            ),
          ),
          Effect.catchAll(error =>
            Effect.forEach(requests, req => request.fail(req, error), {
              discard: true,
            }),
          ),
        ),
    )

    const makeExecute = makeExecuteRequest(Request)
    const execute = makeExecute(Resolver)

    const populateCache = makePopulateCache(Request)
    const invalidateCache = makeInvalidateCache(Request)

    return {
      Request,
      Resolver,
      execute,
      makeExecute,
      populateCache,
      invalidateCache,
    } as any
  }

  function resolverIdMany<T extends string, R, IR, II, IA, AR, AI, A, E, K>(
    tag: T,
    options: {
      readonly request: Schema.Schema<IA, II, IR>
      readonly result: Schema.Schema<A, AI, AR>
      readonly requestId: (_: IA) => K
      readonly resultId: (_: AI) => K
      readonly run: (
        requests: ReadonlyArray<II>,
      ) => Effect.Effect<ReadonlyArray<unknown>, E, R>
    },
  ): Resolver<T, R | IR | AR, IA, ReadonlyArray<A>, E> {
    const Request = request.tagged<Request<T, IA, E, ReadonlyArray<A>>>(tag)
    const encodeRequests = SqlSchema.encode(
      Schema.array(options.request),
      "request",
    )
    const decodeResults = SqlSchema.decodeUnknown(
      Schema.array(options.result),
      "result",
    )
    const Resolver = RequestResolver.makeBatched(
      (requests: Array<Request<T, IA, E, ReadonlyArray<A>>>) =>
        pipe(
          Effect.flatMap(encodeRequests(requests.map(_ => _.i0)), options.run),
          Effect.flatMap(results => {
            const resultsMap = new Map<K, Array<A>>()
            return Effect.map(decodeResults(results), decoded => {
              decoded.forEach((result, i) => {
                const id = options.resultId(results[i] as AI)
                if (resultsMap.has(id)) {
                  resultsMap.get(id)!.push(result)
                } else {
                  resultsMap.set(id, [result])
                }
              })
              return resultsMap
            })
          }),
          Effect.tap(results =>
            Effect.forEach(
              requests,
              req => {
                const id = options.requestId(req.i0)
                const result = results.get(id)
                return request.succeed(req, result ?? [])
              },
              { discard: true },
            ),
          ),
          Effect.catchAllCause(error =>
            Effect.forEach(requests, req => request.failCause(req, error), {
              discard: true,
            }),
          ),
        ),
    )

    const makeExecute = makeExecuteRequest(Request)
    const execute = makeExecute(Resolver)
    const populateCache = makePopulateCache(Request)
    const invalidateCache = makeInvalidateCache(Request)

    return {
      Request,
      Resolver,
      execute,
      makeExecute,
      populateCache,
      invalidateCache,
    } as any
  }

  function resolverId<T extends string, R, IR, II, IA, AR, AI, A, E>(
    tag: T,
    options: {
      readonly id: Schema.Schema<IA, II, IR>
      readonly result: Schema.Schema<A, AI, AR>
      readonly resultId: (_: AI) => IA
      readonly run: (
        requests: ReadonlyArray<II>,
      ) => Effect.Effect<ReadonlyArray<AI>, E, R>
    },
  ): Resolver<T, R | IR | AR, IA, Option.Option<A>, E> {
    const Request = request.tagged<Request<T, IA, E, Option.Option<A>>>(tag)
    const encodeRequests = SqlSchema.encode(Schema.array(options.id), "request")
    const decodeResults = SqlSchema.decodeUnknown(
      Schema.array(options.result),
      "result",
    )
    const Resolver = RequestResolver.makeBatched(
      (requests: Array<Request<T, IA, E, Option.Option<A>>>) =>
        pipe(
          Effect.flatMap(encodeRequests(requests.map(_ => _.i0)), options.run),
          Effect.flatMap(results => {
            const resultsMap = new Map<IA, A>()
            return Effect.map(decodeResults(results), decoded => {
              decoded.forEach((result, i) => {
                const id = options.resultId(results[i])
                resultsMap.set(id, result)
              })
              return resultsMap
            })
          }),
          Effect.tap(results =>
            Effect.forEach(
              requests,
              req => {
                const id = req.i0
                const result = results.get(id)

                return request.succeed(
                  req,
                  result !== undefined ? Option.some(result) : Option.none(),
                )
              },
              { discard: true },
            ),
          ),
          Effect.catchAllCause(error =>
            Effect.forEach(requests, req => request.failCause(req, error), {
              discard: true,
            }),
          ),
        ),
    )

    const makeExecute = makeExecuteRequest(Request)
    const execute = makeExecute(Resolver)
    const populateCache = makePopulateCache(Request)
    const invalidateCache = makeInvalidateCache(Request)

    return {
      Request,
      Resolver,
      execute,
      makeExecute,
      populateCache,
      invalidateCache,
    } as any
  }

  const client: Client = Object.assign(
    Statement.make(getConnection, compiler),
    {
      safe: undefined as any,
      unsafe: Statement.unsafe(getConnection, compiler),
      and: Statement.and,
      or: Statement.or,
      join: Statement.join,
      csv: Statement.csv,
      withTransaction,
      reserve: transactionAcquirer,
      schema,
      schemaSingle,
      schemaSingleOption,
      schemaVoid,
      resolver,
      resolverSingleOption,
      resolverSingle,
      resolverVoid,
      resolverId,
      resolverIdMany,
    },
  )
  ;(client as any).safe = client

  return client
}

/** @internal */
export function defaultTransforms(
  transformer: (str: string) => string,
  nested = true,
) {
  function transformValue(value: any) {
    if (Array.isArray(value)) {
      if (value.length === 0 || value[0].constructor !== Object) {
        return value
      }
      return array(value)
    } else if (value?.constructor === Object) {
      return transformObject(value)
    }
    return value
  }

  function transformObject(obj: Record<string, any>): any {
    const newObj: Record<string, any> = {}
    for (const key in obj) {
      newObj[transformer(key)] = transformValue(obj[key])
    }
    return newObj
  }

  function transformArrayNested<A extends object>(
    rows: ReadonlyArray<A>,
  ): ReadonlyArray<A> {
    const newRows: Array<A> = new Array(rows.length)
    for (let i = 0, len = rows.length; i < len; i++) {
      const row = rows[i]
      const obj: any = {}
      for (const key in row) {
        obj[transformer(key)] = transformValue(row[key])
      }
      newRows[i] = obj
    }
    return newRows
  }

  function transformArray<A extends object>(
    rows: ReadonlyArray<A>,
  ): ReadonlyArray<A> {
    const newRows: Array<A> = new Array(rows.length)
    for (let i = 0, len = rows.length; i < len; i++) {
      const row = rows[i]
      const obj: any = {}
      for (const key in row) {
        obj[transformer(key)] = row[key]
      }
      newRows[i] = obj
    }
    return newRows
  }

  const array = nested ? transformArrayNested : transformArray

  return {
    value: transformValue,
    object: transformObject,
    array,
  } as const
}
