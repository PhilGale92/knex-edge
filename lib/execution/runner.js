const { KnexTimeoutError } = require('../util/timeout');
const { timeout } = require('../util/timeout');
const {
  ensureConnectionCallback,
  ensureConnectionStreamCallback,
} = require('./internal/ensure-connection-callback');

let Transform;

// The "Runner" constructor takes a "builder" (query, schema, or raw)
// and runs through each of the query statements, calling any additional
// "output" method provided alongside the query and bindings.
class Runner {
  constructor(client, builder) {
    this.client = client;
    this.builder = builder;
    this.queries = [];

    // The "connection" object is set on the runner when
    // "run" is called.
    this.connection = undefined;
  }

  // "Run" the target, calling "toSQL" on the builder, returning
  // an object or array of queries to run, each of which are run on
  // a single connection.
  async run() {
    const runner = this;
    try {
      const res = await this.ensureConnection(ensureConnectionCallback);

      // Fire a single "end" event on the builder when
      // all queries have successfully completed.
      runner.builder.emit('end');
      return res;

      // If there are any "error" listeners, we fire an error event
      // and then re-throw the error to be eventually handled by
      // the promise chain. Useful if you're wrapping in a custom `Promise`.
    } catch (err) {
      if (runner.builder._events && runner.builder._events.error) {
        runner.builder.emit('error', err);
      }
      throw err;
    }
  }

  // Stream the result set, by passing through to the dialect's streaming
  // capabilities. If the options are
  stream(optionsOrHandler, handlerOrNil) {
    const firstOptionIsHandler =
      typeof optionsOrHandler === 'function' && arguments.length === 1;

    const options = firstOptionIsHandler ? {} : optionsOrHandler;
    const handler = firstOptionIsHandler ? optionsOrHandler : handlerOrNil;

    // Determines whether we emit an error or throw here.
    const hasHandler = typeof handler === 'function';

    // Lazy-load the "Transform" dependency.
    let streamBuild;
    // eslint-disable-next-line no-undef
    if (typeof EdgeRuntime === 'string') {
      // eslint-disable-next-line no-undef
      streamBuild = Stream;
    } else {
      streamBuild = require('stream');
    }
    Transform = Transform || streamBuild.Transform;

    const queryContext = this.builder.queryContext();

    const stream = new Transform({
      objectMode: true,
      transform: (chunk, _, callback) => {
        callback(null, this.client.postProcessResponse(chunk, queryContext));
      },
    });
    stream.on('close', () => {
      this.client.releaseConnection(this.connection);
    });

    // If the stream is manually destroyed, the close event is not
    // propagated to the top of the pipe chain. We need to manually verify
    // that the source stream is closed and if not, manually destroy it.
    stream.on('pipe', (sourceStream) => {
      const cleanSourceStream = () => {
        if (!sourceStream.closed) {
          sourceStream.destroy();
        }
      };

      // Stream already closed, cleanup immediately
      if (stream.closed) {
        cleanSourceStream();
      } else {
        stream.on('close', cleanSourceStream);
      }
    });

    const connectionAcquirePromise = this.ensureConnection(
      ensureConnectionStreamCallback,
      {
        options,
        hasHandler,
        stream,
      }
    )
      // Emit errors on the stream if the error occurred before a connection
      // could be acquired.
      // If the connection was acquired, assume the error occurred in the client
      // code and has already been emitted on the stream. Don't emit it twice.
      .catch((err) => {
        if (!this.connection) {
          stream.emit('error', err);
        }
      });

    // If a function is passed to handle the stream, send the stream
    // there and return the promise, otherwise just return the stream
    // and the promise will take care of itself.
    if (hasHandler) {
      handler(stream);
      return connectionAcquirePromise;
    }
    return stream;
  }

  // Allow you to pipe the stream to a writable stream.
  pipe(writable, options) {
    return this.stream(options).pipe(writable);
  }

  // "Runs" a query, returning a promise. All queries specified by the builder are guaranteed
  // to run in sequence, and on the same connection, especially helpful when schema building
  // and dealing with foreign key constraints, etc.
  async query(obj) {
    const { __knexUid, __knexTxId } = this.connection;

    this.builder.emit('query', Object.assign({ __knexUid, __knexTxId }, obj));

    const runner = this;
    const queryContext = this.builder.queryContext();
    // query-error events are emitted before the queryPromise continuations.
    // pass queryContext into client.query so it can be raised properly.
    if (obj !== null && typeof obj === 'object') {
      obj.queryContext = queryContext;
    }
    let queryPromise = this.client.query(this.connection, obj);

    if (obj.timeout) {
      queryPromise = timeout(queryPromise, obj.timeout);
    }

    // Await the return value of client.processResponse; in the case of sqlite3's
    // dropColumn()/renameColumn(), it will be a Promise for the transaction
    // containing the complete rename procedure.
    return queryPromise
      .then((resp) => this.client.processResponse(resp, runner))
      .then((processedResponse) => {
        const postProcessedResponse = this.client.postProcessResponse(
          processedResponse,
          queryContext
        );

        this.builder.emit(
          'query-response',
          postProcessedResponse,
          Object.assign({ __knexUid, __knexTxId }, obj),
          this.builder
        );

        this.client.emit(
          'query-response',
          postProcessedResponse,
          Object.assign({ __knexUid, __knexTxId }, obj),
          this.builder
        );

        return postProcessedResponse;
      })
      .catch((error) => {
        if (!(error instanceof KnexTimeoutError)) {
          return Promise.reject(error);
        }
        const { timeout, sql, bindings } = obj;

        let cancelQuery;
        if (obj.cancelOnTimeout) {
          cancelQuery = this.client.cancelQuery(this.connection);
        } else {
          // If we don't cancel the query, we need to mark the connection as disposed so that
          // it gets destroyed by the pool and is never used again. If we don't do this and
          // return the connection to the pool, it will be useless until the current operation
          // that timed out, finally finishes.
          this.connection.__knex__disposed = error;
          cancelQuery = Promise.resolve();
        }

        return cancelQuery
          .catch((cancelError) => {
            // If the cancellation failed, we need to mark the connection as disposed so that
            // it gets destroyed by the pool and is never used again. If we don't do this and
            // return the connection to the pool, it will be useless until the current operation
            // that timed out, finally finishes.
            this.connection.__knex__disposed = error;

            // cancellation failed
            throw Object.assign(cancelError, {
              message: `After query timeout of ${timeout}ms exceeded, cancelling of query failed.`,
              sql,
              bindings,
              timeout,
            });
          })
          .then(() => {
            // cancellation succeeded, rethrow timeout error
            throw Object.assign(error, {
              message: `Defined query timeout of ${timeout}ms exceeded when running query.`,
              sql,
              bindings,
              timeout,
            });
          });
      })
      .catch((error) => {
        this.builder.emit(
          'query-error',
          error,
          Object.assign({ __knexUid, __knexTxId, queryContext }, obj)
        );
        throw error;
      });
  }

  // In the case of the "schema builder" we call `queryArray`, which runs each
  // of the queries in sequence.
  async queryArray(queries) {
    if (queries.length === 1) {
      const query = queries[0];

      if (!query.statementsProducer) {
        return this.query(query);
      }

      const statements = await query.statementsProducer(
        undefined,
        this.connection
      );

      const sqlQueryObjects = statements.sql.map((statement) => ({
        sql: statement,
        bindings: query.bindings,
      }));
      const preQueryObjects = statements.pre.map((statement) => ({
        sql: statement,
        bindings: query.bindings,
      }));
      const postQueryObjects = statements.post.map((statement) => ({
        sql: statement,
        bindings: query.bindings,
      }));

      let results = [];

      await this.queryArray(preQueryObjects);

      try {
        await this.client.transaction(
          async (trx) => {
            const transactionRunner = new Runner(trx.client, this.builder);
            transactionRunner.connection = this.connection;

            results = await transactionRunner.queryArray(sqlQueryObjects);

            if (statements.check) {
              const foreignViolations = await trx.raw(statements.check);

              if (foreignViolations.length > 0) {
                throw new Error('FOREIGN KEY constraint failed');
              }
            }
          },
          { connection: this.connection }
        );
      } finally {
        await this.queryArray(postQueryObjects);
      }

      return results;
    }

    const results = [];
    for (const query of queries) {
      results.push(await this.queryArray([query]));
    }
    return results;
  }

  // Check whether there's a transaction flag, and that it has a connection.
  async ensureConnection(cb, cbParams) {
    // Use override from a builder if passed
    if (this.builder._connection) {
      this.connection = this.builder._connection;
    }

    if (this.connection) {
      return cb(this, cbParams);
    }

    let acquiredConnection;
    try {
      acquiredConnection = await this.client.acquireConnection();
    } catch (error) {
      if (!(error instanceof KnexTimeoutError)) {
        return Promise.reject(error);
      }
      if (this.builder) {
        error.sql = this.builder.sql;
        error.bindings = this.builder.bindings;
      }
      throw error;
    }
    try {
      this.connection = acquiredConnection;
      return await cb(this, cbParams);
    } finally {
      await this.client.releaseConnection(acquiredConnection);
    }
  }
}

module.exports = Runner;
