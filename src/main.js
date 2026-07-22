import "./style.css";   // the exact Python-frontend stylesheet
import App from "./App.svelte";

const app = new App({ target: document.getElementById("app") });
export default app;
