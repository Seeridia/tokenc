import { useState } from "react";

import { counterMaximum, counterMinimum, counterStep } from "./generated/tokens";
import { useTheme } from "./theme";

const pipeline = [
  ["1", "DTCG source", "tokens/*.json"],
  ["2", "tokenc build", "tokenc.config.ts"],
  ["3", "Generated API", "tokens.css + tokens.ts"],
  ["4", "React", "visual theme + counter logic"],
] as const;

export function App() {
  const [count, setCount] = useState(0);
  const { theme, toggleTheme } = useTheme();

  const decrement = () => setCount((value) => Math.max(counterMinimum, value - counterStep));
  const increment = () => setCount((value) => Math.min(counterMaximum, value + counterStep));

  return (
    <main className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">tokenc × React</p>
          <h1>A tiny counter with a real token pipeline.</h1>
          <p className="lede">
            Theme colors come from generated CSS variables. Counter limits and step size come from
            generated TypeScript constants.
          </p>
        </div>
        <button className="theme-button" type="button" onClick={toggleTheme}>
          {theme === "light" ? "Switch to dark" : "Switch to light"}
        </button>
      </header>

      <section className="counter-card" aria-labelledby="counter-title">
        <p id="counter-title" className="counter-label">
          Current count
        </p>
        <output className="counter-value" aria-live="polite">
          {count}
        </output>
        <div className="counter-actions">
          <button
            className="control-button secondary"
            type="button"
            disabled={count === counterMinimum}
            onClick={decrement}
          >
            − {counterStep}
          </button>
          <button className="control-button secondary" type="button" onClick={() => setCount(0)}>
            Reset
          </button>
          <button
            className="control-button primary"
            type="button"
            disabled={count === counterMaximum}
            onClick={increment}
          >
            + {counterStep}
          </button>
        </div>
        <p className="counter-range">
          Range {counterMinimum}…{counterMaximum}, compiled from <code>counter.*</code> tokens.
        </p>
      </section>

      <section className="pipeline" aria-labelledby="pipeline-title">
        <div>
          <p className="eyebrow">One source of truth</p>
          <h2 id="pipeline-title">How the values reach this page</h2>
        </div>
        <ol>
          {pipeline.map(([number, title, detail]) => (
            <li key={number}>
              <span>{number}</span>
              <strong>{title}</strong>
              <code>{detail}</code>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
