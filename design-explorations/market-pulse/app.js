const scenarioButtons = [...document.querySelectorAll('header [data-scenario]')];
scenarioButtons.forEach((button) => button.addEventListener('click', () => {
  document.body.dataset.scenario = button.dataset.scenario;
  scenarioButtons.forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
}));

const context = document.querySelector('.context');
const mandateToggle = document.querySelector('.mandate-toggle');
mandateToggle.addEventListener('click', () => {
  context.classList.toggle('open');
  mandateToggle.setAttribute('aria-expanded', String(context.classList.contains('open')));
});

document.querySelectorAll('.marker').forEach((marker) => marker.addEventListener('click', () => {
  const target = document.querySelector(`.${marker.dataset.carrier}-card`);
  target.scrollIntoView({behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center'});
  target.animate([{background:'#fff6d7'},{background:'transparent'}], {duration:700});
}));

document.querySelector('.reconnect').addEventListener('click', () => {
  document.body.dataset.scenario = 'winner';
  scenarioButtons.forEach((item) => item.setAttribute('aria-pressed', String(item.dataset.scenario === 'winner')));
});

document.querySelector('.decision-action').addEventListener('click', (event) => {
  event.currentTarget.textContent = document.body.dataset.scenario === 'winner' ? 'Ganador confirmado' : 'Intervención solicitada';
  event.currentTarget.disabled = true;
});
