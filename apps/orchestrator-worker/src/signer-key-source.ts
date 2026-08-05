import { Wallet, type JsonRpcProvider } from 'ethers';

/**
 * A raw private key in an ordinary environment variable is fine for local/testnet development
 * but is not something a real production deployment should accept -- there is no secret rotation,
 * no audit trail, and any process (or process dump) that can read env can exfiltrate the key
 * outright. This abstraction lets the worker load a signer without every caller caring which of
 * those two shapes the underlying secret actually is.
 */
export interface SignerKeySource {
  readonly kind: 'raw-env' | 'encrypted-keystore';
  loadWallet(provider: JsonRpcProvider): Promise<Wallet>;
}

export class RawEnvKeySource implements SignerKeySource {
  readonly kind = 'raw-env';
  readonly #privateKey: `0x${string}`;

  constructor(privateKey: `0x${string}`) {
    this.#privateKey = privateKey;
  }

  async loadWallet(provider: JsonRpcProvider): Promise<Wallet> {
    return new Wallet(this.#privateKey, provider);
  }
}

/**
 * A real, standard (web3 secret storage / "V3 keystore") encrypted-at-rest key: the private key
 * never sits in plaintext in an env var, config file, or process listing -- decryption happens
 * once, in memory, at boot, and requires the separately-supplied password. This is the same
 * format MetaMask/geth produce; `scripts/testnet/encrypt-keystore.mjs` creates one from a raw key.
 * It is a real step up from a plaintext env var, though it is still not a remote HSM/KMS -- the
 * decrypted key exists in this process's memory for the worker's lifetime either way.
 */
export class EncryptedKeystoreKeySource implements SignerKeySource {
  readonly kind = 'encrypted-keystore';
  readonly #keystoreJson: string;
  readonly #password: string;

  constructor(keystoreJson: string, password: string) {
    this.#keystoreJson = keystoreJson;
    this.#password = password;
  }

  async loadWallet(provider: JsonRpcProvider): Promise<Wallet> {
    const decrypted = await Wallet.fromEncryptedJson(this.#keystoreJson, this.#password);
    return new Wallet(decrypted.privateKey, provider);
  }
}
