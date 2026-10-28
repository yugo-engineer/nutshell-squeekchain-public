import { publicClient, getAccount } from "./scripts/chain";
const a = getAccount().address;
const [latest, pending] = await Promise.all([publicClient.getTransactionCount({ address: a, blockTag: "latest" }), publicClient.getTransactionCount({ address: a, blockTag: "pending" })]);
console.log("nonce latest", latest, "pending", pending, "block", await publicClient.getBlockNumber());
