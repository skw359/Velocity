import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';

// Init theme immediately to prevent flash
if (localStorage.getItem('velocity-theme') === 'light') {
  document.body.setAttribute('data-theme', 'light');
}

createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>
);
