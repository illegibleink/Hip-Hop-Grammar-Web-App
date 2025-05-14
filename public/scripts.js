document.addEventListener('DOMContentLoaded', () => {
  console.log('Body dataset:', document.body.dataset);
  const purchasedSets = JSON.parse(document.body.dataset.purchasedSets || '[]');
  console.log('Parsed purchasedSets:', purchasedSets);
  const setIdToCheck = document.body.dataset.highlightSetId;
  const userId = document.body.dataset.userId;
  console.log('Client-side userId:', userId);
  console.log(`Is ${setIdToCheck} in purchasedSets?`, purchasedSets.includes(setIdToCheck));

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

  // Stripe and playlist logic (unchanged, just streamlined)
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
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'Checkout failed');
        if (!data.url) throw new Error('No checkout URL received');
        window.location.href = data.url;
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