const { expect } = require("chai");
const { IPFSClient, getIPFSClient } = require("../agents/ipfs-client");
const { LitClient, getLitClient } = require("../agents/lit-client");

describe("M2/M3 Storage & Privacy Adapters (mock mode)", function () {
    describe("IPFSClient (mock)", function () {
        it("Should upload and fetch content", async function () {
            const ipfs = new IPFSClient({ mode: "mock" });
            const content = "Hello, ASB blockchain world!";
            const { cid, size } = await ipfs.upload(content);
            expect(cid).to.match(/^mock-[a-f0-9]{32}$/);
            expect(size).to.equal(Buffer.byteLength(content));
            const fetched = await ipfs.fetch(cid);
            expect(fetched.toString()).to.equal(content);
        });

        it("Should generate different CIDs for different content", async function () {
            const ipfs = new IPFSClient({ mode: "mock" });
            const a = await ipfs.upload("alpha");
            const b = await ipfs.upload("beta");
            expect(a.cid).to.not.equal(b.cid);
        });
    });

    describe("LitClient (mock)", function () {
        it("Should encrypt and decrypt with worker pubKey", async function () {
            const lit = new LitClient({ mode: "mock" });
            const workerPubKey = "0x1234567890123456789012345678901234567890";
            const task = "分析这份敏感的财务报告";
            const encrypted = await lit.encrypt(task, workerPubKey);
            expect(encrypted.ciphertext).to.be.a("string");
            expect(encrypted.mock).to.be.true;

            const decrypted = await lit.decrypt(encrypted, { address: workerPubKey });
            expect(decrypted).to.equal(task);
        });

        it("Should reject decrypt from non-authorized address", async function () {
            const lit = new LitClient({ mode: "mock" });
            const encrypted = await lit.encrypt("secret", "0xAAAA");
            const hasAccess = await lit.checkAccess(encrypted, "0xBBBB");
            expect(hasAccess).to.be.false;
        });
    });
});
