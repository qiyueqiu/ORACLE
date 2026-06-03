// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title PaymentEscrow (改造 6)
 * @notice 用户发起任务时托管费用；任务完成且审计通过后释放给 Worker；失败回滚给用户
 *
 * 流程：
 *   1. 用户调 createTask(worker, deadline) + approve token → 创建托管
 *   2. AuditLog updateExecutionWithSig 成功（status=1）时调 release(recordId)
 *   3. 或者失败/超时 → 用户调 refund(recordId)
 *   4. 平台抽成 feeBps 留给 owner
 */
contract PaymentEscrow is Ownable, ReentrancyGuard {
    enum TaskStatus { None, Funded, Released, Refunded }

    IERC20 public immutable paymentToken;
    uint256 public feeBps;            // 平台抽成基点
    address public auditLog;          // AuditLog 合约地址

    struct Escrow {
        address payer;
        address worker;
        uint256 amount;
        uint256 deadline;
        TaskStatus status;
    }

    mapping(uint256 => Escrow) public escrows;  // recordId => escrow
    uint256 public totalFees;

    event TaskFunded(uint256 indexed recordId, address indexed payer, address indexed worker, uint256 amount);
    event TaskReleased(uint256 indexed recordId, address indexed worker, uint256 amount, uint256 fee);
    event TaskRefunded(uint256 indexed recordId, address indexed payer, uint256 amount);
    event FeeBpsUpdated(uint256 newBps);
    event AuditLogUpdated(address indexed newAuditLog);

    constructor(IERC20 _token) Ownable(msg.sender) {
        paymentToken = _token;
        feeBps = 200;  // 默认 2%
        auditLog = address(0);
    }

    modifier onlyAuditLog() {
        require(msg.sender == auditLog, "Only AuditLog");
        _;
    }

    function setAuditLog(address _auditLog) external onlyOwner {
        auditLog = _auditLog;
        emit AuditLogUpdated(_auditLog);
    }

    function setFeeBps(uint256 newBps) external onlyOwner {
        require(newBps <= 5000, "Fee > 50%");
        feeBps = newBps;
        emit FeeBpsUpdated(newBps);
    }

    /**
     * 用户托管费用；recordId 由 AuditLog 分配
     */
    function fundTask(uint256 recordId, address worker, uint256 deadline, uint256 amount) external nonReentrant {
        require(escrows[recordId].status == TaskStatus.None, "RecordId already used");
        require(worker != address(0), "Zero worker");
        require(amount > 0, "Zero amount");
        require(block.timestamp <= deadline, "Past deadline");

        escrows[recordId] = Escrow({
            payer: msg.sender,
            worker: worker,
            amount: amount,
            deadline: deadline,
            status: TaskStatus.Funded
        });

        require(paymentToken.transferFrom(msg.sender, address(this), amount), "Transfer failed");
        emit TaskFunded(recordId, msg.sender, worker, amount);
    }

    /**
     * 由 AuditLog 调用：任务完成释放
     */
    function release(uint256 recordId) external onlyAuditLog nonReentrant {
        Escrow storage e = escrows[recordId];
        require(e.status == TaskStatus.Funded, "Not funded");

        uint256 fee = (e.amount * feeBps) / 10000;
        uint256 payout = e.amount - fee;
        e.status = TaskStatus.Released;
        totalFees += fee;

        require(paymentToken.transfer(e.worker, payout), "Worker transfer failed");
        if (fee > 0) {
            require(paymentToken.transfer(owner(), fee), "Fee transfer failed");
        }
        emit TaskReleased(recordId, e.worker, payout, fee);
    }

    /**
     * 用户主动退款：仅在 deadline 已过且任务未完成时可调
     */
    function refund(uint256 recordId) external nonReentrant {
        Escrow storage e = escrows[recordId];
        require(e.status == TaskStatus.Funded, "Not funded");
        require(msg.sender == e.payer, "Not payer");
        require(block.timestamp > e.deadline, "Not past deadline");

        e.status = TaskStatus.Refunded;
        require(paymentToken.transfer(e.payer, e.amount), "Refund failed");
        emit TaskRefunded(recordId, e.payer, e.amount);
    }

    function getEscrow(uint256 recordId) external view returns (Escrow memory) {
        return escrows[recordId];
    }

    function withdrawFees() external onlyOwner nonReentrant {
        uint256 bal = paymentToken.balanceOf(address(this));
        uint256 fees = totalFees;
        require(fees > 0, "No fees");
        totalFees = 0;
        require(paymentToken.transfer(owner(), fees), "Withdraw failed");
    }
}
