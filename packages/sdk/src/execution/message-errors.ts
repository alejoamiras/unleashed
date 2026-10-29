/** The L1→L2 message isn't consumable until the sequencer folds it into a block AND this wallet's
 *  PXE syncs it; both claim paths revert with one of these wordings until then. This is the NOT-YET
 *  shape ONLY — it must NOT match the already-consumed shape (see isMsgConsumed): upstream 5.0.0
 *  distinguishes them (`No L1 to L2 message found` = not anchored; `No NON-NULLIFIED L1 to L2 message
 *  found` = anchored but nullified), and the two consumers want opposite conditions. `No L1 to L2
 *  message found` is anchored with a word boundary so the "non-nullified" infix can't match here. */
export const isMsgNotReady = (msg: string): boolean =>
	/l1_to_l2_msg_exists|nonexistent L1-to-L2|message not in state|(?<!non-nullified )No L1 to L2 message found/i.test(msg)

/** The already-CONSUMED (nullified) shape: the message was anchored and this claim's nullifier is
 *  already in the tree. 5.0.0's claim oracle checks the nullifier, so a re-claim of consumed FJ
 *  throws `No non-nullified L1 to L2 message found` (@aztec-labs/stdlib l1_to_l2_message). Distinct from
 *  isMsgNotReady — matching that here would (a) treat a not-yet-anchored message as consumed and
 *  latch a false "claimed" [fund-stranding], and (b) never recognise the real consumed shape. */
export const isMsgConsumed = (msg: string): boolean =>
	/No non-nullified L1 to L2 message found|message has already been nullified|L1-to-L2 message is already nullified/i.test(msg)
