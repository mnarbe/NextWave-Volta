const scenarioButtons = [...document.querySelectorAll('header [data-scenario]')];
scenarioButtons.forEach((button) => button.addEventListener('click', () => {
  document.body.dataset.scenario = button.dataset.scenario;
  scenarioButtons.forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
}));

document.querySelectorAll('.ticket-main').forEach((button) => button.addEventListener('click', () => {
  const ticket = button.closest('.ticket');
  ticket.classList.toggle('open');
  button.setAttribute('aria-expanded', String(ticket.classList.contains('open')));
}));

document.querySelector('.reconnect').addEventListener('click', () => {
  document.body.dataset.scenario = 'winner';
  scenarioButtons.forEach((item) => item.setAttribute('aria-pressed', String(item.dataset.scenario === 'winner')));
});

document.querySelector('.decision-action').addEventListener('click', (event) => {
  event.currentTarget.textContent = document.body.dataset.scenario === 'winner' ? 'Adjudicación confirmada' : 'Intervención solicitada';
  event.currentTarget.disabled = true;
});
