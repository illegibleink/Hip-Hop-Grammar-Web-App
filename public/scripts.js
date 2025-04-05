document.addEventListener('DOMContentLoaded', () => {
  // Theme handling: default to dark mode, persist across pages
  const toggleButton = document.getElementById('theme-toggle');
  const body = document.body;
  const themeIcon = toggleButton ? toggleButton.querySelector('.theme-icon') : null;

  // Apply saved theme or default to dark
  const savedTheme = localStorage.getItem('theme') || 'dark';
  body.classList.add(`${savedTheme}-mode`);
  if (themeIcon) {
    themeIcon.textContent = savedTheme === 'dark' ? '☀' : '☾';
  }

  // Toggle event listener
  if (toggleButton) {
    toggleButton.addEventListener('click', () => {
      const isDark = body.classList.contains('dark-mode');
      body.classList.replace(`${isDark ? 'dark' : 'light'}-mode`, `${isDark ? 'light' : 'dark'}-mode`);
      themeIcon.textContent = isDark ? '☾' : '☀';
      localStorage.setItem('theme', isDark ? 'light' : 'dark');
    });
  }

  // Stripe and playlist-specific logic (only applies to index.ejs)
  const stripe = Stripe(document.body.dataset.stripeKey || '');
  const buyButtons = document.querySelectorAll('.buy-now');
  const saveButtons = document.querySelectorAll('.save-to-spotify');

  buyButtons.forEach(button => {
    button.addEventListener('click', async () => {
      const setId = button.dataset.setId;
      button.disabled = true;
      button.textContent = 'Processing...';

      try {
        const response = await fetch(`/checkout?setId=${setId}`, {
          method: 'GET',
          headers: { 'Accept': 'application/json' }
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || 'Checkout failed');
        }

        const { url } = await response.json();
        if (!url) throw new Error('No checkout URL received');

        window.location.href = url;
      } catch (error) {
        console.error('Checkout error:', error.message);
        alert(`Failed to initiate payment: ${error.message}`);
      } finally {
        button.disabled = false;
        button.textContent = 'Unlock';
      }
    });
  });

  saveButtons.forEach(button => {
    button.addEventListener('click', async () => {
      const setId = button.dataset.setId;
      button.disabled = true;

      try {
        const response = await fetch('/save-to-spotify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ setId })
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || 'Save failed');
        }

        const data = await response.json();
        if (data.success) {
          button.classList.add('saved');
          alert('Playlist saved to Spotify!');
        }
      } catch (error) {
        console.error('Save error:', error.message);
        alert(`Failed to save playlist: ${error.message}`);
      } finally {
        button.disabled = false;
      }
    });
  });

  // Scroll to highlighted set (only on index.ejs)
  const highlightSetId = document.body.dataset.highlightSetId;
  if (highlightSetId) {
    const highlightedElement = document.querySelector(`.playlist-card[data-set-id="${highlightSetId}"]`);
    if (highlightedElement) {
      highlightedElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
});