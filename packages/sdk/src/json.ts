import { types as nodeTypes } from 'node:util';
import { AcclimateUsageError } from './errors.js';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function assertJson(
  value: unknown,
  maximum: number,
  root = 'output',
): asserts value is Json {
  const active = new Set<object>();
  const visit = (x: unknown, field: string): void => {
    const invalid = (reason: string): never => {
      throw new AcclimateUsageError(reason, field);
    };
    if (x === null || typeof x === 'boolean') return;
    if (typeof x === 'string') {
      if (/[\ud800-\udfff]/u.test(x)) invalid('Use a valid Unicode string.');
      return;
    }
    if (typeof x === 'number') {
      if (!Number.isFinite(x) || (Number.isInteger(x) && !Number.isSafeInteger(x)))
        invalid('Use a finite JSON number or encode large integers as strings.');
      return;
    }
    if (!x || typeof x !== 'object') return invalid('Use a JSON value or omit this object field.');
    if (nodeTypes.isProxy(x)) invalid('Return a plain JSON object instead of a proxy.');
    if (active.has(x)) invalid('Remove the circular reference.');
    if (nodeTypes.isDate(x)) invalid('Convert Date to an ISO string with toISOString().');
    if (
      !Array.isArray(x) &&
      Object.getPrototypeOf(x) !== Object.prototype &&
      Object.getPrototypeOf(x) !== null
    )
      invalid('Convert class instances and collections to plain JSON objects or arrays.');
    if (Reflect.ownKeys(x).some((k) => typeof k !== 'string' || /[\ud800-\udfff]/u.test(k)))
      invalid('Use Unicode string property names.');
    active.add(x);
    if (Array.isArray(x)) {
      if (Object.getPrototypeOf(x) !== Array.prototype) invalid('Use a plain array.');
      const entries = Object.getOwnPropertyDescriptors(x) as unknown as Record<
        string,
        PropertyDescriptor
      >;
      const length = entries.length?.value;
      if (!Number.isSafeInteger(length) || length < 0 || Object.keys(entries).length !== length + 1)
        invalid('Use a dense array without extra properties.');
      for (let i = 0; i < length; i++) {
        const item = entries[String(i)];
        if (!item || !('value' in item) || !item.enumerable)
          invalid('Use ordinary array elements.');
        visit(item.value, `${field}[${i}]`.slice(0, 512));
      }
    } else {
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(x))) {
        const child = (field + '[' + JSON.stringify(key.slice(0, 100)) + ']').slice(0, 512);
        if (!('value' in descriptor) || !descriptor.enumerable)
          throw new AcclimateUsageError(
            'Use an enumerable data field instead of an accessor.',
            child,
          );
        visit(descriptor.value, child);
      }
    }
    active.delete(x);
  };
  visit(value, root);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maximum)
    throw new AcclimateUsageError(
      `Return at most ${maximum} bytes of JSON. Store larger evidence privately and return a digest.`,
      root,
    );
}
