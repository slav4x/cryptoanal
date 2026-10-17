import { Client } from "pg";

export class BoundedPgClient extends Client {
  public override query = ((...args: unknown[]) => {
    const failed = (error: unknown) => {
      if (error instanceof Error && error.message === "Query read timeout") {
        // A lost response leaves the protocol busy even after pg rejects the query.
        // Discard the connection so a transaction cannot return it to the pool.
        void this.end().catch(() => {});
      }
    };
    const callback = args.at(-1);
    if (typeof callback === "function")
      args[args.length - 1] = (...values: unknown[]) => {
        failed(values[0]);
        return Reflect.apply(callback, undefined, values);
      };
    const result: unknown = Reflect.apply(Client.prototype.query, this, args);
    return result instanceof Promise
      ? result.catch((error: unknown) => {
          failed(error);
          throw error;
        })
      : result;
  }) as Client["query"];
}
