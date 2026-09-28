import { mount } from "svelte";
import App from "./App.svelte";
import { poll } from "./app.svelte.ts";

mount(App, { target: document.body });
void poll();
