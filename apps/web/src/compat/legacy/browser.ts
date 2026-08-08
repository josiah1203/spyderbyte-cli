import './styles.css';

const root = document.querySelector<HTMLElement>('#app');
if (root === null) throw new Error('Compatibility shell root is missing');

root.innerHTML = `
  <main class="compatibility-shell" aria-labelledby="compatibility-title">
    <p class="compatibility-shell__eyebrow">Spyderbyte</p>
    <h1 id="compatibility-title">The product UI moved to the canonical React frontend.</h1>
    <p>
      This package remains available for migration and transport tests. Launch
      the React application served by <code>apps/web</code>.
    </p>
  </main>
`;
