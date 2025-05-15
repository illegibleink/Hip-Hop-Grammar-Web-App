document.addEventListener('DOMContentLoaded', () => {
  // Apply saved theme once
  const savedTheme = localStorage.getItem('theme') || 'dark';
  document.body.classList.add(`${savedTheme}-mode`);

  // Theme toggle
  const toggleButton = document.getElementById('theme-toggle');
  const body = document.body;
  const themeIcon = toggleButton?.querySelector('.theme-icon');
  if (toggleButton && themeIcon) {
    themeIcon.textContent = savedTheme === 'dark' ? '☀' : '☾';
    toggleButton.addEventListener('click', () => {
      const isDark = body.classList.contains('dark-mode');
      body.classList.replace(`${isDark ? 'dark' : 'light'}-mode`, `${isDark ? 'light' : 'dark'}-mode`);
      themeIcon.textContent = isDark ? '☾' : '☀';
      localStorage.setItem('theme', isDark ? 'light' : 'dark');
    });
  }

  // Stripe and playlist logic
  const stripe = Stripe(document.body.dataset.stripeKey || '');
  const buyButtons = document.querySelectorAll('.buy-now');
  const saveButtons = document.querySelectorAll('.save-to-spotify');

  // Fix 3: Log purchasedSets from data attribute
  const purchasedSets = JSON.parse(document.body.dataset.purchasedSets || '[]');
  console.log('Client-side purchasedSets:', purchasedSets);

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
        if (!response.ok) throw new Error((await response.json()).error || 'Checkout failed');
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
        if (!response.ok) throw new Error((await response.json()).error || 'Save failed');
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

  // Scroll to highlighted set
  const highlightSetId = document.body.dataset.highlightSetId;
  if (highlightSetId) {
    const highlightedElement = document.querySelector(`.playlist-card[data-set-id="${highlightSetId}"]`);
    highlightedElement?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
});