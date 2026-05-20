const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

describe("LawbBuilding (UUPS upgradeable)", function () {
  let building, mockToken, owner, alice, bob, signer, treasury;
  const MINT_PRICE = ethers.parseEther("0.00028");
  const ROYALTY_BPS = 500;

  async function signMint(to, repoId, rarity, fileSizeKB, deadline) {
    const domain = {
      name: "Lawbworld",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await building.getAddress(),
    };
    const types = {
      Mint: [
        { name: "to", type: "address" },
        { name: "repoIdHash", type: "bytes32" },
        { name: "rarity", type: "uint8" },
        { name: "fileSizeKB", type: "uint32" },
        { name: "deadline", type: "uint256" },
      ],
    };
    const value = {
      to,
      repoIdHash: ethers.keccak256(ethers.toUtf8Bytes(repoId)),
      rarity,
      fileSizeKB,
      deadline,
    };
    return signer.signTypedData(domain, types, value);
  }

  async function mintAs(user, repo, rarity = 2, size = 200, options = {}) {
    const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
    const sig = await signMint(user.address, repo, rarity, size, deadline);
    return building.connect(user).mint(repo, rarity, size, deadline, sig, {
      value: MINT_PRICE,
      ...options,
    });
  }

  beforeEach(async () => {
    [owner, alice, bob, signer, treasury] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockLawbworldToken");
    mockToken = await Mock.deploy();
    await mockToken.waitForDeployment();
    await mockToken.transfer(alice.address, ethers.parseEther("100000000"));
    await mockToken.transfer(bob.address,   ethers.parseEther("100000000"));

    const Building = await ethers.getContractFactory("LawbBuilding");
    building = await upgrades.deployProxy(
      Building,
      [owner.address, signer.address, treasury.address, ROYALTY_BPS],
      { kind: "uups", initializer: "initialize" }
    );
    await building.waitForDeployment();
  });

  describe("mint", () => {
    it("mints a building when signed and paid", async () => {
      await expect(mintAs(alice, "did:key:abc/repo1", 3, 1024)).to.emit(building, "Minted");
      expect(await building.ownerOf(1)).to.equal(alice.address);
      const b = await building.getBuilding(1);
      expect(b.repoId).to.equal("did:key:abc/repo1");
      expect(b.rarity).to.equal(3);
      expect(b.level).to.equal(1);
      expect(b.fileSizeKB).to.equal(1024);
    });

    it("refunds excess ETH", async () => {
      const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
      const sig = await signMint(alice.address, "did:key:abc/r1", 0, 50, deadline);
      const before = await ethers.provider.getBalance(alice.address);
      const tx = await building.connect(alice).mint("did:key:abc/r1", 0, 50, deadline, sig, {
        value: ethers.parseEther("1.0"),
      });
      const rc = await tx.wait();
      const after = await ethers.provider.getBalance(alice.address);
      const spent = before - after;
      const gas = rc.gasUsed * rc.gasPrice;
      expect(spent - gas).to.equal(MINT_PRICE);
    });

    it("rejects underpayment", async () => {
      const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
      const sig = await signMint(alice.address, "did:key:abc/r1", 0, 50, deadline);
      await expect(
        building.connect(alice).mint("did:key:abc/r1", 0, 50, deadline, sig, { value: 1 })
      ).to.be.revertedWithCustomError(building, "Underpaid");
    });

    it("rejects expired signature", async () => {
      const past = (await ethers.provider.getBlock("latest")).timestamp - 10;
      const sig = await signMint(alice.address, "did:key:abc/r1", 0, 50, past);
      await expect(
        building.connect(alice).mint("did:key:abc/r1", 0, 50, past, sig, { value: MINT_PRICE })
      ).to.be.revertedWithCustomError(building, "SignatureExpired");
    });

    it("rejects forged signature from a non-signer", async () => {
      const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
      // bob forges signature
      const badSig = await bob.signTypedData(
        { name: "Lawbworld", version: "1",
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await building.getAddress() },
        { Mint: [
          { name: "to", type: "address" }, { name: "repoIdHash", type: "bytes32" },
          { name: "rarity", type: "uint8" }, { name: "fileSizeKB", type: "uint32" },
          { name: "deadline", type: "uint256" },
        ]},
        { to: alice.address,
          repoIdHash: ethers.keccak256(ethers.toUtf8Bytes("did:key:abc/r1")),
          rarity: 4, fileSizeKB: 1, deadline }
      );
      await expect(
        building.connect(alice).mint("did:key:abc/r1", 4, 1, deadline, badSig, { value: MINT_PRICE })
      ).to.be.revertedWithCustomError(building, "BadSignature");
    });

    it("rejects double-mint of same repo", async () => {
      await mintAs(alice, "did:key:abc/repo1", 0, 50);
      await expect(mintAs(bob, "did:key:abc/repo1", 0, 50)).to.be.revertedWithCustomError(building, "AlreadyMinted");
    });

    it("rejects bad rarity", async () => {
      await expect(mintAs(alice, "did:key:abc/r", 5, 50)).to.be.revertedWithCustomError(building, "BadRarity");
    });

    it("pause blocks mint", async () => {
      await building.pause();
      await expect(mintAs(alice, "did:key:abc/repo1", 0, 50)).to.be.reverted;
      await building.unpause();
      await mintAs(alice, "did:key:abc/repo1", 0, 50);
    });
  });

  describe("mintBatch", () => {
    it("mints 3 in a single tx", async () => {
      const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
      const repos = ["did/a", "did/b", "did/c"];
      const rar   = [0, 1, 2];
      const sizes = [50, 100, 200];
      const sigs  = await Promise.all(repos.map((r,i) => signMint(alice.address, r, rar[i], sizes[i], deadline)));
      const dl    = [deadline, deadline, deadline];
      const tx = await building.connect(alice).mintBatch(repos, rar, sizes, dl, sigs, {
        value: MINT_PRICE * 3n,
      });
      await tx.wait();
      expect(await building.balanceOf(alice.address)).to.equal(3);
      expect(await building.nextTokenId()).to.equal(4);
    });

    it("rejects mismatched arrays", async () => {
      const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
      const sig = await signMint(alice.address, "x", 0, 50, deadline);
      await expect(
        building.connect(alice).mintBatch(["x","y"], [0], [50,60], [deadline,deadline], [sig,sig], { value: MINT_PRICE * 2n })
      ).to.be.revertedWithCustomError(building, "ArrayMismatch");
    });
  });

  describe("upgrade (with $LAWBWORLD set)", () => {
    beforeEach(async () => {
      await building.setLawbworldToken(await mockToken.getAddress());
      await mintAs(alice, "did:key:abc/repo1", 2, 200);
      await mockToken.connect(alice).approve(await building.getAddress(), ethers.parseEther("100000000"));
    });

    it("level 1 → 2 burns 100 000 LAWBWORLD", async () => {
      const before = await mockToken.balanceOf(alice.address);
      await expect(building.connect(alice).upgrade(1))
        .to.emit(building, "LevelUp")
        .withArgs(1, 2, ethers.parseEther("100000"));
      const after = await mockToken.balanceOf(alice.address);
      expect(before - after).to.equal(ethers.parseEther("100000"));
      expect((await building.getBuilding(1)).level).to.equal(2);
    });

    it("cost is linear: lv 2→3 burns 200 000", async () => {
      await building.connect(alice).upgrade(1);
      const before = await mockToken.balanceOf(alice.address);
      await building.connect(alice).upgrade(1);
      const after = await mockToken.balanceOf(alice.address);
      expect(before - after).to.equal(ethers.parseEther("200000"));
    });

    it("rejects non-owner", async () => {
      await expect(building.connect(bob).upgrade(1)).to.be.revertedWithCustomError(building, "NotOwner");
    });

    it("caps at MAX_LEVEL (10) — 9→10 burns 900 000", async () => {
      for (let i = 0; i < 9; i++) await building.connect(alice).upgrade(1);
      expect((await building.getBuilding(1)).level).to.equal(10);
      await expect(building.connect(alice).upgrade(1)).to.be.revertedWithCustomError(building, "MaxLevel");
    });

    it("upgradeCost reports linear schedule and 0 at max", async () => {
      expect(await building.upgradeCost(1)).to.equal(ethers.parseEther("100000"));
      await building.connect(alice).upgrade(1);
      expect(await building.upgradeCost(1)).to.equal(ethers.parseEther("200000"));
      await building.connect(alice).upgrade(1);
      expect(await building.upgradeCost(1)).to.equal(ethers.parseEther("300000"));
      for (let i = 0; i < 7; i++) await building.connect(alice).upgrade(1);
      expect(await building.upgradeCost(1)).to.equal(0);
    });

    it("pause blocks upgrade", async () => {
      await building.pause();
      await expect(building.connect(alice).upgrade(1)).to.be.reverted;
    });
  });

  describe("upgrade (token not set)", () => {
    it("reverts cleanly before $LAWBWORLD is configured", async () => {
      await mintAs(alice, "did:key:abc/repo1", 2, 200);
      await expect(building.connect(alice).upgrade(1)).to.be.revertedWithCustomError(building, "TokenNotSet");
    });
  });

  describe("royalty (ERC-2981)", () => {
    it("returns 5% royalty to treasury", async () => {
      await mintAs(alice, "did/r", 0, 50);
      const sale = ethers.parseEther("1");
      const [receiver, amount] = await building.royaltyInfo(1, sale);
      expect(receiver).to.equal(treasury.address);
      expect(amount).to.equal(sale * BigInt(ROYALTY_BPS) / 10000n);
    });

    it("owner can update royalty", async () => {
      await building.setDefaultRoyalty(bob.address, 750);
      await mintAs(alice, "did/r", 0, 50);
      const [receiver, amount] = await building.royaltyInfo(1, ethers.parseEther("1"));
      expect(receiver).to.equal(bob.address);
      expect(amount).to.equal(ethers.parseEther("0.075"));
    });

    it("supportsInterface for ERC2981", async () => {
      expect(await building.supportsInterface("0x2a55205a")).to.equal(true);
      expect(await building.supportsInterface("0x80ac58cd")).to.equal(true);
    });
  });

  describe("admin", () => {
    it("owner can set mint price", async () => {
      await building.setMintPrice(ethers.parseEther("0.001"));
      expect(await building.mintPrice()).to.equal(ethers.parseEther("0.001"));
    });

    it("owner can set the $LAWBWORLD token address", async () => {
      const addr = await mockToken.getAddress();
      await expect(building.setLawbworldToken(addr)).to.emit(building, "LawbworldTokenUpdated");
      expect(await building.lawbworld()).to.equal(addr);
    });

    it("owner can rotate the mint signer", async () => {
      await building.setMintSigner(bob.address);
      expect(await building.mintSigner()).to.equal(bob.address);
    });

    it("rejects zero-address signer", async () => {
      await expect(building.setMintSigner(ethers.ZeroAddress)).to.be.revertedWithCustomError(building, "ZeroAddress");
    });

    it("owner can withdraw collected ETH", async () => {
      await mintAs(alice, "did/r1", 0, 50);
      const before = await ethers.provider.getBalance(bob.address);
      await building.withdraw(bob.address);
      const after = await ethers.provider.getBalance(bob.address);
      expect(after - before).to.equal(MINT_PRICE);
    });

    it("non-owner cannot set price", async () => {
      await expect(building.connect(alice).setMintPrice(1)).to.be.reverted;
    });

    it("non-owner cannot pause", async () => {
      await expect(building.connect(alice).pause()).to.be.reverted;
    });
  });
});
