// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/common/ERC2981Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

interface ILawbworldToken {
    function burnFrom(address account, uint256 amount) external;
}

/**
 * @title LawbBuilding
 * @notice UUPS-upgradeable ERC-721 representing a building (a `gitlawb` repo) in Lawbworld.
 *         Rarity and file size are signed by a trusted `mintSigner` (the lawbworld
 *         server) so users cannot forge a legendary mint from a 1-KB repo.
 *
 * - Mint price: 0.0003 ETH (tweakable by owner via setMintPrice).
 * - Each repo (`<did>/<name>`) can only be minted once.
 * - Upgrades burn `$LAWBWORLD` — the token address is set after the Bankr
 *   launchpad listing via `setLawbworldToken`. Cost formula:
 *     level 1 → 2 burns 10 000 LAWBWORLD
 *     level 2 → 3 burns 20 000
 *     each step doubles up to level 10 (final step = 2 560 000)
 * - Owner can pause mint/upgrade in emergency, withdraw the mint pot, change
 *   royalty, swap the signer, and upgrade the implementation.
 */
contract LawbBuilding is
    Initializable,
    ERC721Upgradeable,
    ERC2981Upgradeable,
    OwnableUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardTransient,
    EIP712Upgradeable,
    UUPSUpgradeable
{
    using Strings for uint256;

    struct Building {
        string  repoId;
        uint8   rarity;
        uint8   level;
        uint32  fileSizeKB;
        uint64  mintedAt;
    }

    uint8   public constant MAX_LEVEL    = 10;
    uint256 public constant UPGRADE_BASE = 100_000 ether;

    bytes32 private constant MINT_TYPEHASH = keccak256(
        "Mint(address to,bytes32 repoIdHash,uint8 rarity,uint32 fileSizeKB,uint256 deadline)"
    );

    uint256 public mintPrice;
    string  public baseTokenURI;
    ILawbworldToken public lawbworld;
    address public mintSigner;
    uint256 public nextTokenId;

    mapping(uint256 => Building) public buildings;
    mapping(bytes32 => uint256)  public repoToToken;

    uint256[40] private __gap;

    error Underpaid();
    error BadRarity();
    error EmptyRepoId();
    error AlreadyMinted();
    error TokenNotSet();
    error NotOwner();
    error MaxLevel();
    error ZeroAddress();
    error WithdrawFailed();
    error RefundFailed();
    error SignatureExpired();
    error BadSignature();
    error ArrayMismatch();
    error EmptyBatch();

    event Minted(uint256 indexed tokenId, address indexed owner, string repoId, uint8 rarity, uint32 fileSizeKB);
    event LevelUp(uint256 indexed tokenId, uint8 newLevel, uint256 lawbBurned);
    event MintPriceUpdated(uint256 oldPrice, uint256 newPrice);
    event BaseURIUpdated(string newBaseURI);
    event LawbworldTokenUpdated(address indexed oldToken, address indexed newToken);
    event MintSignerUpdated(address indexed oldSigner, address indexed newSigner);
    event RoyaltyUpdated(address receiver, uint96 feeBps);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    function initialize(
        address initialOwner,
        address initialSigner,
        address royaltyReceiver,
        uint96  royaltyBps
    ) external initializer {
        __ERC721_init("Lawbworld Buildings", "LAWBLDG");
        __ERC2981_init();
        __Ownable_init(initialOwner);
        __Pausable_init();
        __EIP712_init("Lawbworld", "1");
        mintPrice = 0.00028 ether;
        nextTokenId = 1;
        mintSigner = initialSigner;
        _setDefaultRoyalty(royaltyReceiver, royaltyBps);
        emit MintSignerUpdated(address(0), initialSigner);
        emit RoyaltyUpdated(royaltyReceiver, royaltyBps);
    }

    function mint(
        string calldata repoId,
        uint8  rarity,
        uint32 fileSizeKB,
        uint256 deadline,
        bytes calldata sig
    )
        external payable nonReentrant whenNotPaused returns (uint256 tokenId)
    {
        tokenId = _mintOne(repoId, rarity, fileSizeKB, deadline, sig);
        _settleEth(mintPrice);
    }

    function mintBatch(
        string[]  calldata repoIds,
        uint8[]   calldata rarities,
        uint32[]  calldata fileSizes,
        uint256[] calldata deadlines,
        bytes[]   calldata sigs
    )
        external payable nonReentrant whenNotPaused returns (uint256[] memory tokenIds)
    {
        uint256 n = repoIds.length;
        if (n == 0) revert EmptyBatch();
        if (rarities.length != n || fileSizes.length != n || deadlines.length != n || sigs.length != n) revert ArrayMismatch();
        tokenIds = new uint256[](n);
        uint256 totalCost = mintPrice * n;
        for (uint256 i = 0; i < n; i++) {
            tokenIds[i] = _mintOne(repoIds[i], rarities[i], fileSizes[i], deadlines[i], sigs[i]);
        }
        _settleEth(totalCost);
    }

    function _mintOne(
        string calldata repoId,
        uint8  rarity,
        uint32 fileSizeKB,
        uint256 deadline,
        bytes calldata sig
    ) internal returns (uint256 tokenId) {
        if (rarity > 4) revert BadRarity();
        if (bytes(repoId).length == 0) revert EmptyRepoId();
        if (block.timestamp > deadline) revert SignatureExpired();

        bytes32 repoIdHash = keccak256(bytes(repoId));
        if (repoToToken[repoIdHash] != 0) revert AlreadyMinted();

        bytes32 structHash = keccak256(abi.encode(
            MINT_TYPEHASH, msg.sender, repoIdHash, rarity, fileSizeKB, deadline
        ));
        address recovered = ECDSA.recover(_hashTypedDataV4(structHash), sig);
        if (recovered == address(0) || recovered != mintSigner) revert BadSignature();

        tokenId = nextTokenId++;
        buildings[tokenId] = Building({
            repoId:     repoId,
            rarity:     rarity,
            level:      1,
            fileSizeKB: fileSizeKB,
            mintedAt:   uint64(block.timestamp)
        });
        repoToToken[repoIdHash] = tokenId;

        _safeMint(msg.sender, tokenId);
        emit Minted(tokenId, msg.sender, repoId, rarity, fileSizeKB);
    }

    function _settleEth(uint256 required) internal {
        if (msg.value < required) revert Underpaid();
        if (msg.value > required) {
            (bool ok, ) = payable(msg.sender).call{value: msg.value - required}("");
            if (!ok) revert RefundFailed();
        }
    }

    function upgrade(uint256 tokenId) external nonReentrant whenNotPaused {
        if (address(lawbworld) == address(0)) revert TokenNotSet();
        if (ownerOf(tokenId) != msg.sender) revert NotOwner();
        Building storage b = buildings[tokenId];
        if (b.level >= MAX_LEVEL) revert MaxLevel();

        uint256 cost = _costAtLevel(b.level);
        b.level += 1;
        lawbworld.burnFrom(msg.sender, cost);

        emit LevelUp(tokenId, b.level, cost);
    }

    function _costAtLevel(uint8 level) internal pure returns (uint256) {
        unchecked { return UPGRADE_BASE * uint256(level); }
    }

    function upgradeCost(uint256 tokenId) external view returns (uint256) {
        Building storage b = buildings[tokenId];
        if (b.level >= MAX_LEVEL) return 0;
        return _costAtLevel(b.level);
    }

    function _baseURI() internal view override returns (string memory) {
        return baseTokenURI;
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        string memory base = _baseURI();
        if (bytes(base).length == 0) return "";
        return string(abi.encodePacked(base, tokenId.toString()));
    }

    function getBuilding(uint256 tokenId) external view returns (Building memory) {
        _requireOwned(tokenId);
        return buildings[tokenId];
    }

    function isMinted(string calldata repoId) external view returns (bool) {
        return repoToToken[keccak256(bytes(repoId))] != 0;
    }

    function setMintPrice(uint256 newPrice) external onlyOwner {
        emit MintPriceUpdated(mintPrice, newPrice);
        mintPrice = newPrice;
    }

    function setBaseURI(string calldata newBaseURI) external onlyOwner {
        baseTokenURI = newBaseURI;
        emit BaseURIUpdated(newBaseURI);
    }

    function setLawbworldToken(address token) external onlyOwner {
        emit LawbworldTokenUpdated(address(lawbworld), token);
        lawbworld = ILawbworldToken(token);
    }

    function setMintSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert ZeroAddress();
        emit MintSignerUpdated(mintSigner, newSigner);
        mintSigner = newSigner;
    }

    function setDefaultRoyalty(address receiver, uint96 feeBps) external onlyOwner {
        _setDefaultRoyalty(receiver, feeBps);
        emit RoyaltyUpdated(receiver, feeBps);
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    function withdraw(address payable to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        (bool ok, ) = to.call{value: address(this).balance}("");
        if (!ok) revert WithdrawFailed();
    }

    function supportsInterface(bytes4 id)
        public view override(ERC721Upgradeable, ERC2981Upgradeable) returns (bool)
    {
        return super.supportsInterface(id);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}
}
