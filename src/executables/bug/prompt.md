<!--
Container role: no agent runs. The transition logic lives entirely in
profile.json's `children[].next` map (driven by the container loop in
src/executor.ts:runContainerLoop). This file exists only because the
profile loader expects a prompt.md sibling.
-->
