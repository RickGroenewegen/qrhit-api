/**
 * Recording mocks for outbound side-effect singletons (Mail, Pushover, ...).
 *
 * The real classes have large APIs; instead of stubbing every method we
 * return a Proxy whose every method records its invocation in `outbound`
 * and resolves to undefined. Suites can assert on what was "sent"
 * (e.g. registration mail containing a verification hash) via
 * `outbound.calls('Mail', 'sendQRSongVerificationMail')`, and can override
 * a method's return value with `outbound.respondWith(...)`.
 */

export interface RecordedCall {
  target: string;
  method: string;
  args: any[];
}

class OutboundRegistry {
  public records: RecordedCall[] = [];
  public blockedFetches: string[] = [];
  private responders = new Map<string, (...args: any[]) => any>();

  key(target: string, method: string): string {
    return `${target}.${method}`;
  }

  calls(target: string, method?: string): RecordedCall[] {
    return this.records.filter(
      (r) => r.target === target && (!method || r.method === method)
    );
  }

  respondWith(target: string, method: string, fn: (...args: any[]) => any): void {
    this.responders.set(this.key(target, method), fn);
  }

  handle(target: string, method: string, args: any[]): any {
    this.records.push({ target, method, args });
    const responder = this.responders.get(this.key(target, method));
    if (responder) {
      return responder(...args);
    }
    return Promise.resolve(undefined);
  }

  reset(): void {
    this.records = [];
    this.blockedFetches = [];
    this.responders.clear();
  }
}

export const outbound = new OutboundRegistry();

function makeRecordingInstance(name: string): any {
  return new Proxy(
    {},
    {
      get(_t, prop: string | symbol) {
        if (typeof prop !== 'string') return undefined;
        // Promise-likeness probes must return undefined, or `await instance`
        // would treat the proxy as a thenable and hang.
        if (prop === 'then' || prop === 'catch' || prop === 'finally') {
          return undefined;
        }
        return (...args: any[]) => outbound.handle(name, prop, args);
      },
    }
  );
}

/**
 * Module factory for vi.mock(): default export is a class with the common
 * singleton shape (getInstance) that also works when constructed directly
 * (`new Mail()`), both returning the same recording proxy.
 */
export function makeRecordingSingleton(name: string): { default: any } {
  const instance = makeRecordingInstance(name);
  const klass = function () {
    return instance;
  } as any;
  klass.getInstance = () => instance;
  klass.setInstance = () => undefined;
  return { default: klass };
}
