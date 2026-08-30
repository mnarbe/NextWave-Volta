const scenarioButtons = [...document.querySelectorAll('[data-scenario]')].filter((el) => el.tagName === 'BUTTON');
scenarioButtons.forEach((button) => button.addEventListener('click', () => {
  document.body.dataset.scenario = button.dataset.scenario;
  scenarioButtons.forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
}));

document.querySelectorAll('.carrier-main').forEach((button) => button.addEventListener('click', () => {
  const carrier = button.closest('.carrier');
  carrier.classList.toggle('open');
  button.setAttribute('aria-expanded', String(carrier.classList.contains('open')));
}));

const mandateDialog = document.querySelector('#mandate-detail');
document.querySelector('[data-drawer="mandate-detail"]').addEventListener('click', () => mandateDialog.showModal());
mandateDialog.querySelector('.close').addEventListener('click', () => mandateDialog.close());

document.querySelector('.reconnect').addEventListener('click', () => {
  document.body.dataset.scenario = 'winner';
  scenarioButtons.forEach((item) => item.setAttribute('aria-pressed', String(item.dataset.scenario === 'winner')));
});

document.querySelectorAll('.decision-action').forEach((button) => button.addEventListener('click', () => {
  button.textContent = document.body.dataset.scenario === 'winner' ? 'Adjudicación confirmada' : 'Intervención solicitada';
  button.disabled = true;
}));
