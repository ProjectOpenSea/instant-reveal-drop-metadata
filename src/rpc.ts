/**
 * A tiny read-only Ethereum client. No dependencies, and only the four calls
 * this server needs.
 *
 * Function selectors are the first four bytes of keccak256 of the signature.
 * They are hardcoded so this file does not need a hashing library:
 *
 *   ownerOf(uint256)          0x6352211e
 *   totalSupply()             0x18160ddd
 *   maxSupply()               0xd5abeb01
 *   baseURI()                 0x6c0360eb
 *   owner()                   0x8da5cb5b
 *   name()                    0x06fdde03
 *   symbol()                  0x95d89b41
 *   tokenURI(uint256)         0xc87b56dd
 *   supportsInterface(bytes4) 0x01ffc9a7
 *
 * Verify any of them yourself with `cast sig "ownerOf(uint256)"`.
 */

export const SELECTORS = {
  ownerOf: "0x6352211e",
  totalSupply: "0x18160ddd",
  maxSupply: "0xd5abeb01",
  baseURI: "0x6c0360eb",
  owner: "0x8da5cb5b",
  name: "0x06fdde03",
  symbol: "0x95d89b41",
  tokenURI: "0xc87b56dd",
  supportsInterface: "0x01ffc9a7",
} as const;

/** ERC-721 interface ID, for supportsInterface. */
export const ERC721_INTERFACE_ID = "0x80ac58cd";
/** ERC-1155 interface ID. */
export const ERC1155_INTERFACE_ID = "0xd9b67a26";

/** The contract reverted. Distinct from "the RPC endpoint is having a bad day". */
export class RevertError extends Error {
  readonly data: string | undefined;
  constructor(message: string, data?: string) {
    super(message);
    this.name = "RevertError";
    this.data = data;
  }
}

/** The RPC endpoint failed, timed out, or returned something unusable. */
export class RpcTransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RpcTransportError";
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type RpcClientOptions = {
  url: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
};

export class RpcClient {
  readonly url: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private nextId = 1;

  constructor(options: RpcClientOptions) {
    this.url = options.url;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async send(method: string, params: unknown[]): Promise<unknown> {
    const body = JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params });

    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new RpcTransportError(`${method} request failed`, { cause: error });
    }

    if (!response.ok) {
      throw new RpcTransportError(`${method} returned HTTP ${response.status}`);
    }

    let payload: { result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
    try {
      payload = (await response.json()) as typeof payload;
    } catch (error) {
      throw new RpcTransportError(`${method} returned invalid JSON`, { cause: error });
    }

    if (payload.error) {
      const data = typeof payload.error.data === "string" ? payload.error.data : undefined;
      const message = payload.error.message ?? "unknown RPC error";
      // Reverts arrive as a normal JSON-RPC error. Code 3 is the common one,
      // but endpoints differ, so also match on the message.
      if (payload.error.code === 3 || /revert|execution reverted/i.test(message)) {
        throw new RevertError(message, data);
      }
      throw new RpcTransportError(`${method}: ${message}`);
    }

    return payload.result;
  }

  async call(to: string, data: string, blockTag: string = "latest"): Promise<string> {
    const result = await this.send("eth_call", [{ to, data }, blockTag]);
    if (typeof result !== "string") {
      throw new RpcTransportError("eth_call did not return hex data");
    }
    return result;
  }

  async blockNumber(): Promise<number> {
    const result = await this.send("eth_blockNumber", []);
    if (typeof result !== "string") throw new RpcTransportError("eth_blockNumber failed");
    return Number(BigInt(result));
  }
}

// --- The smallest possible slice of ABI encoding and decoding ---------------

/** Encode one uint256 argument, appended to a selector. */
export function encodeUint256(selector: string, value: number | bigint): string {
  return selector + BigInt(value).toString(16).padStart(64, "0");
}

/** Encode one bytes4 argument (for supportsInterface). */
export function encodeBytes4(selector: string, value: string): string {
  const clean = value.replace(/^0x/, "").padEnd(8, "0").slice(0, 8);
  return selector + clean.padEnd(64, "0");
}

/**
 * Parse a hex word. Malformed return data is an RPC problem, not a crash: an
 * endpoint that answers with something unexpected must surface as a transport
 * error so the caller fails closed, rather than as a raw SyntaxError from BigInt.
 */
function hexWordToBigInt(clean: string, what: string): bigint {
  if (!/^[0-9a-fA-F]+$/.test(clean)) {
    throw new RpcTransportError(`return data is not hex where ${what} was expected`);
  }
  return BigInt("0x" + clean);
}

export function decodeUint256(hex: string): bigint {
  const clean = hex.replace(/^0x/, "");
  if (clean.length === 0) throw new RpcTransportError("empty return data where a number was expected");
  return hexWordToBigInt(clean.slice(0, 64), "a number");
}

export function decodeAddress(hex: string): string {
  const clean = hex.replace(/^0x/, "");
  if (clean.length < 64) throw new RpcTransportError("return data too short for an address");
  return "0x" + clean.slice(24, 64);
}

/** Decode a dynamically sized ABI string return value. */
export function decodeString(hex: string): string {
  const clean = hex.replace(/^0x/, "");
  if (clean.length < 128) return "";
  const offset = Number(hexWordToBigInt(clean.slice(0, 64), "a string offset")) * 2;
  if (!Number.isSafeInteger(offset) || offset + 64 > clean.length) return "";
  const length = Number(hexWordToBigInt(clean.slice(offset, offset + 64), "a string length"));
  if (!Number.isSafeInteger(length) || offset + 64 + length * 2 > clean.length) return "";
  const bytesHex = clean.slice(offset + 64, offset + 64 + length * 2);
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    bytes[i] = Number.parseInt(bytesHex.slice(i * 2, i * 2 + 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

export function decodeBool(hex: string): boolean {
  const clean = hex.replace(/^0x/, "");
  if (clean.length === 0) return false;
  return hexWordToBigInt(clean.slice(0, 64), "a boolean") !== 0n;
}

// --- Contract reads --------------------------------------------------------

export async function readTotalSupply(
  client: RpcClient,
  contract: string,
  blockTag?: string,
): Promise<bigint> {
  return decodeUint256(await client.call(contract, SELECTORS.totalSupply, blockTag));
}

/**
 * True if the token exists. `ownerOf` reverts for an unminted token ID
 * (`OwnerQueryForNonexistentToken()`, 0xdf2d9b42, on the ERC721A contracts
 * OpenSea Studio deploys), which is exactly the signal we want.
 */
export async function readTokenExists(
  client: RpcClient,
  contract: string,
  tokenId: number,
  blockTag?: string,
): Promise<boolean> {
  try {
    const result = await client.call(contract, encodeUint256(SELECTORS.ownerOf, tokenId), blockTag);
    return decodeUint256(result) !== 0n;
  } catch (error) {
    if (error instanceof RevertError) return false;
    throw error;
  }
}

export async function readString(
  client: RpcClient,
  contract: string,
  selector: string,
): Promise<string> {
  return decodeString(await client.call(contract, selector));
}

export async function readSupportsInterface(
  client: RpcClient,
  contract: string,
  interfaceId: string,
): Promise<boolean> {
  try {
    return decodeBool(
      await client.call(contract, encodeBytes4(SELECTORS.supportsInterface, interfaceId)),
    );
  } catch (error) {
    if (error instanceof RevertError) return false;
    throw error;
  }
}
