Sparse edit format: name distinctive current fragments, elide the rest with `…`, state each change inline or as a rewrite block.

<ops>
Payload = `[relative/path.ts]` header, then operations; repeat headers for more files; sections apply atomically.

`«` opens an operation that MUST match once; `«*` applies it to every match. One rewrite form per operation:
- Inline: `⟪current│desired⟫` — same-line changes (renames, operator flips, argument tweaks). `⟪old│⟫` deletes; `⟪│new⟫` inserts.
- Block: MATCH lines, `»`, REWRITE lines stating the final text — multi-line restructuring (swap, move, wrap, rewrite). Empty REWRITE deletes the whole MATCH.

In MATCH: `…` = gap/capture — stays on its line between fragments, spans lines at line end. No markers → REWRITE replaces the whole MATCH.
In REWRITE or a desired side: `…` re-emits captured gaps in order; a lone `»N` line re-emits operation N's deleted text (moves never retype the block).
</ops>

<rules>
- MATCH MUST include a fragment of the changed line; context alone can hit the wrong place.
- Every REWRITE/desired line is written to the file verbatim — NEVER add annotation lines like `//`.
- Indentation is content: MATCH forgives wrong leading whitespace; REWRITE lines land exactly as typed. Give every REWRITE line — the first included — its final file depth, in the file's indent character. A column-0 line amid indented ones is applied flattened, silently.
- AVOID retyping unchanged lines; `…` re-emits them with their original indentation.
- AVOID selections spanning lines; a `»` REWRITE states multi-line results more reliably.
- NEVER combine `⟪old│new⟫` with a `»` REWRITE, or inline with bare `⟪old⟫`, in one operation.
- Operations address the original file; earlier ops never shift later anchors. Matching forgives whitespace and identifier typos; operators and delimiters MUST match exactly.
- A failure applies nothing and includes a copy-ready corrected payload: send that verbatim.
- "No change" means the anchor already reads as your final text; look elsewhere.
- To write markers (`«»⟪│⟫`) literally, use `write`.
</rules>

<example>
Inline changes, jointly matched:
```text
[src/config.ts]
«
const timeout = ⟪1000│5000⟫;
const retries = ⟪3│5⟫;
```

Fix every match:
```text
[src/catalog.ts]
«*
logger.⟪debug│trace⟫(
```

Multi-line rewrite (swap bodies) — MATCH, `»`, final text:
```text
[src/footer.ts]
«
} else if (percent > 70) {
  str = display;
} else {
  str = warn(display);
}
»
} else if (percent > 70) {
  str = warn(display);
} else {
  str = display;
}
```

Move a block — delete, then re-emit with `»1`:
```text
[src/util.ts]
«
const helper = () => {
  return 1;
};
»
«
const target = () => 2;
»
»1
```

Sparse gaps carry untyped lines through:
```text
[src/users.ts]
«
loadUser(…
⟪const user = legacyStore.read(…);⟫…
}
»
const user = await database.users.read(…);
```
</example>

<critical>
1. First line is `[path]`; `«` opens every operation.
2. Same-line change → `⟪old│new⟫`. Multi-line rewrite → MATCH + `»` + final text.
3. REWRITE indentation is verbatim: every retyped line — anchors included — carries the exact leading whitespace it must have in the file; wrong depth or style applies silently.
4. Prove one unique match anchored on the changed line, or use `«*`.
5. After an error, send the supplied corrected payload verbatim — nothing was applied; NEVER freestyle a new guess.
6. Edit FIRST, straight from text already in the conversation: matching is fuzzy and every failure shows the current lines. Read only what neither the conversation nor an error shows.
</critical>
