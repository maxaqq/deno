// Copyright 2018-2019 the Deno authors. All rights reserved. MIT license.
// Do not add flatbuffer dependencies to this module.
import * as util from "./util";
import { core } from "./core";

const promiseTableMin = new Map<number, util.Resolvable<number>>();
let _nextPromiseId = 1;

function nextPromiseId(): number {
  return _nextPromiseId++;
}

export interface RecordMinimal {
  promiseId: number;
  opId: number; // Maybe better called dispatchId
  arg: number;
  result: number;
}

export function recordFromBufMinimal(
  opId: number,
  buf32: Int32Array
): RecordMinimal {
  if (buf32.length != 3) {
    throw Error("Bad message");
  }
  return {
    promiseId: buf32[0],
    opId,
    arg: buf32[1],
    result: buf32[2]
  };
}

const scratch32 = new Int32Array(3);
const scratchBytes = new Uint8Array(
  scratch32.buffer,
  scratch32.byteOffset,
  scratch32.byteLength
);
util.assert(scratchBytes.byteLength === scratch32.length * 4);

export function asyncMsgFromRust(opId: number, ui8: Uint8Array): void {
  const buf32 = new Int32Array(ui8.buffer, ui8.byteOffset, ui8.byteLength / 4);
  const record = recordFromBufMinimal(opId, buf32);
  const { promiseId, result } = record;
  const promise = promiseTableMin.get(promiseId);
  promiseTableMin.delete(promiseId);
  promise!.resolve(result);
}

export function sendAsyncMinimal(
  opId: number,
  arg: number,
  zeroCopy: Uint8Array
): Promise<number> {
  const promiseId = nextPromiseId(); // AKA cmdId
  scratch32[0] = promiseId;
  scratch32[1] = arg;
  scratch32[2] = 0; // result
  const promise = util.createResolvable<number>();
  promiseTableMin.set(promiseId, promise);
  core.dispatch(opId, scratchBytes, zeroCopy);
  return promise;
}
