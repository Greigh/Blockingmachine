declare module 'dns-packet' {
  export const AUTHORITATIVE_ANSWER: number;
  export function decode(buf: Buffer, offset?: number): any;
  export function encode(packet: any, buf?: Buffer, offset?: number): Buffer;
  export const RECURSION_DESIRED: number;
  export const RECURSION_AVAILABLE: number;
}
