// Shared wallet + on-chain helper for index.html / mint.html / discover.html.
// Loads ethers v6 from CDN (the page must include <script src="ethers.umd.min.js">).

(function (global) {
  const CHAIN_PRESETS = {
    84532: { name: "Base Sepolia", rpcUrls: ["https://base-sepolia.publicnode.com"], blockExplorerUrls: ["https://sepolia.basescan.org"], nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } },
    8453:  { name: "Base",         rpcUrls: ["https://base.publicnode.com"],         blockExplorerUrls: ["https://basescan.org"],         nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } },
  };
  const _state = { chain: null, proxy: null, configReady: null };

  const ABI = [
    "function mint(string repoId,uint8 rarity,uint32 fileSizeKB,uint256 deadline,bytes sig) payable returns (uint256)",
    "function upgrade(uint256 tokenId)",
    "function upgradeCost(uint256 tokenId) view returns (uint256)",
    "function mintPrice() view returns (uint256)",
    "function nextTokenId() view returns (uint256)",
    "function isMinted(string repoId) view returns (bool)",
    "function repoToToken(bytes32) view returns (uint256)",
    "function getBuilding(uint256) view returns (tuple(string repoId,uint8 rarity,uint8 level,uint32 fileSizeKB,uint64 mintedAt))",
    "function ownerOf(uint256) view returns (address)",
    "function lawbworld() view returns (address)",
    "function mintSigner() view returns (address)",
    "function balanceOf(address owner) view returns (uint256)",
    "event Minted(uint256 indexed tokenId,address indexed owner,string repoId,uint8 rarity,uint32 fileSizeKB)",
    "event LevelUp(uint256 indexed tokenId,uint8 newLevel,uint256 lawbBurned)",
  ];
  const ERC20_ABI = [
    "function approve(address,uint256) returns (bool)",
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
  ];

  const W = {
    chain: null,
    proxy: null,
    abi: ABI,
    provider: null,
    signer: null,
    address: null,

    async loadConfig() {
      if (_state.configReady) return _state.configReady;
      _state.configReady = (async () => {
        try {
          const info = await fetch("/api/mint-sig/info").then(r => r.json());
          if (info && info.verifyingContract) {
            const chainId = info.chainId | 0;
            const preset = CHAIN_PRESETS[chainId] || CHAIN_PRESETS[84532];
            this.chain = {
              id: chainId,
              hex: "0x" + chainId.toString(16),
              name: preset.name,
              rpcUrls: preset.rpcUrls,
              blockExplorerUrls: preset.blockExplorerUrls,
              nativeCurrency: preset.nativeCurrency,
            };
            this.proxy = info.verifyingContract;
          }
        } catch (_) {}
        if (!this.chain) {
          const preset = CHAIN_PRESETS[84532];
          this.chain = { id: 84532, hex: "0x14a34", ...preset };
        }
      })();
      return _state.configReady;
    },

    isWalletAvailable() { return typeof window.ethereum !== "undefined"; },

    onAccountsChanged(cb) {
      if (this.isWalletAvailable()) window.ethereum.on("accountsChanged", cb);
    },
    onChainChanged(cb) {
      if (this.isWalletAvailable()) window.ethereum.on("chainChanged", cb);
    },

    async connect() {
      await this.loadConfig();
      if (!this.isWalletAvailable()) throw new Error("No wallet found. Install MetaMask, Coinbase Wallet, or Rabby.");
      if (typeof ethers === "undefined") throw new Error("ethers.js not loaded");
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      if (!accounts.length) throw new Error("No account approved");
      await this.ensureChain();
      this.provider = new ethers.BrowserProvider(window.ethereum);
      this.signer = await this.provider.getSigner();
      this.address = await this.signer.getAddress();
      try { localStorage.setItem("lawb_wallet_connected", "1"); } catch (_) {}
      return this.address;
    },

    async restore() {
      try {
        await this.loadConfig();
        if (!this.isWalletAvailable() || typeof ethers === "undefined") return null;
        if (localStorage.getItem("lawb_wallet_connected") !== "1") return null;
        const accounts = await window.ethereum.request({ method: "eth_accounts" });
        if (!accounts.length) return null;
        this.provider = new ethers.BrowserProvider(window.ethereum);
        this.signer = await this.provider.getSigner();
        this.address = await this.signer.getAddress();
        return this.address;
      } catch (_) { return null; }
    },

    disconnect() {
      this.provider = null;
      this.signer = null;
      this.address = null;
      try { localStorage.removeItem("lawb_wallet_connected"); } catch (_) {}
    },

    async ensureChain() {
      await this.loadConfig();
      const id = await window.ethereum.request({ method: "eth_chainId" });
      if (parseInt(id, 16) === this.chain.id) return;
      try {
        await window.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: this.chain.hex }],
        });
      } catch (e) {
        if (e && (e.code === 4902 || (e.data && e.data.originalError && e.data.originalError.code === 4902))) {
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: this.chain.hex,
              chainName: this.chain.name,
              rpcUrls: this.chain.rpcUrls,
              blockExplorerUrls: this.chain.blockExplorerUrls,
              nativeCurrency: this.chain.nativeCurrency,
            }],
          });
        } else throw e;
      }
    },

    contract() {
      if (!this.signer) throw new Error("Wallet not connected");
      if (!this.proxy) throw new Error("Contract address not loaded");
      return new ethers.Contract(this.proxy, ABI, this.signer);
    },

    async readContract() {
      await this.loadConfig();
      if (typeof ethers === "undefined") throw new Error("ethers.js not loaded");
      if (!this.proxy) throw new Error("Contract address not loaded");
      const rpc = new ethers.JsonRpcProvider(this.chain.rpcUrls[0]);
      return new ethers.Contract(this.proxy, ABI, rpc);
    },

    async ethBalance() {
      if (!this.signer || !this.provider) return 0n;
      return this.provider.getBalance(this.address);
    },

    async fetchMintSig(fullId) {
      const r = await fetch("/api/mint-sig", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullId, walletAddress: this.address }),
      }).then(r => r.json());
      if (!r.ok) throw new Error(r.error || "sign failed");
      return r;
    },

    async mint(fullId, onProgress) {
      if (!this.signer) throw new Error("Connect wallet first");
      const cb = onProgress || (() => {});
      cb(10, "fetching mint signature…");
      const sig = await this.fetchMintSig(fullId);
      cb(35, "submitting transaction…");
      const c = this.contract();
      const price = await c.mintPrice();
      const tx = await c.mint(sig.repoId, sig.rarity, sig.fileSizeKB, sig.deadline, sig.signature, { value: price });
      cb(65, "waiting for confirmation…");
      const rc = await tx.wait();
      cb(95, "indexing on server…");
      try {
        await fetch("/api/mint", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fullId, walletAddress: this.address, txHash: rc.hash }),
        });
      } catch (_) {}
      cb(100, "minted · tx " + rc.hash.slice(0, 10) + "…");
      return { tx: rc.hash, receipt: rc };
    },

    async getOnchainStatus(fullId) {
      await this.loadConfig();
      const ro = await this.readContract();
      const hash = ethers.keccak256(ethers.toUtf8Bytes(fullId));
      const tokenId = await ro.repoToToken(hash);
      if (tokenId === 0n) return { minted: false };
      const [owner, b] = await Promise.all([ro.ownerOf(tokenId), ro.getBuilding(tokenId)]);
      return {
        minted: true,
        tokenId: Number(tokenId),
        owner,
        level: Number(b.level),
        rarity: Number(b.rarity),
        fileSizeKB: Number(b.fileSizeKB),
      };
    },

    async upgrade(fullId, onProgress) {
      if (!this.signer) throw new Error("Connect wallet first");
      const cb = onProgress || (() => {});
      cb(5, "fetching token id…");
      const c = this.contract();
      const hash = ethers.keccak256(ethers.toUtf8Bytes(fullId));
      const tokenId = await c.repoToToken(hash);
      if (tokenId === 0n) throw new Error("not minted on-chain yet");
      cb(15, "reading upgrade cost…");
      const [lawbAddr, cost] = await Promise.all([c.lawbworld(), c.upgradeCost(tokenId)]);
      if (lawbAddr === ethers.ZeroAddress) throw new Error("$LAWBWORLD not deployed yet (waiting for Bankr launch)");
      if (cost === 0n) throw new Error("already max level");
      const erc20 = new ethers.Contract(lawbAddr, ERC20_ABI, this.signer);
      cb(25, "checking allowance…");
      const allowance = await erc20.allowance(this.address, this.proxy);
      if (allowance < cost) {
        cb(40, "approving $LAWBWORLD…");
        const tx1 = await erc20.approve(this.proxy, cost);
        await tx1.wait();
      }
      cb(70, "upgrading on-chain…");
      const tx2 = await c.upgrade(tokenId);
      cb(88, "waiting for confirmation…");
      const rc = await tx2.wait();
      cb(100, "done · tx " + rc.hash.slice(0,10) + "…");
      return { tx: rc.hash, receipt: rc, tokenId: Number(tokenId), cost };
    },

    fmtToken(weiAmount) {
      return ethers.formatUnits(weiAmount, 18);
    },

    short(addr) {
      const a = addr || this.address;
      if (!a) return "—";
      return a.slice(0, 6) + "…" + a.slice(-4);
    },
  };

  global.LawbWallet = W;
})(typeof window !== "undefined" ? window : globalThis);
