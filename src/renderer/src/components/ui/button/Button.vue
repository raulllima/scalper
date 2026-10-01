<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(defineProps<{ variant?: "default" | "outline" | "ghost" | "danger"; size?: "default" | "sm" }>(), {
  variant: "default", size: "default"
});

const classes = computed(() => [
  "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-400 disabled:pointer-events-none disabled:opacity-50",
  props.size === "sm" ? "h-8 px-3 text-xs" : "h-10 px-4 text-sm",
  { default: "bg-lime-400 text-zinc-950 hover:bg-lime-300", outline: "border border-zinc-700 bg-transparent text-zinc-100 hover:bg-zinc-800", ghost: "bg-transparent text-zinc-300 hover:bg-zinc-800", danger: "bg-rose-500 text-white hover:bg-rose-400" }[props.variant]
]);
</script>

<template><button :class="classes"><slot /></button></template>
