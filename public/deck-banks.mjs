export const DECK_LETTERS=['A','B','C','D'];
export function mountDeckBanks(container,decks,navigationHost=container){
  container.classList.add('deck-banks');
  const nav=document.createElement('div');nav.className='deck-bank-bar';nav.setAttribute('aria-label','Deck 分组');
  const tabs=document.createElement('div');tabs.className='deck-bank-tabs';tabs.setAttribute('role','group');tabs.setAttribute('aria-label','选择 Deck 分组');
  nav.append(tabs);navigationHost.append(nav);
  let active=0;
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  const pairs=[['A','B'],['C','D']].map((letters,index)=>{
    const panel=document.createElement('div');panel.className='deck-pair';panel.id='deck-pair-'+index;
    for(const letter of letters)panel.append(decks[letter].root);
    container.append(panel);
    const button=document.createElement('button');button.type='button';button.textContent=letters.join(' / ');button.setAttribute('aria-label','显示 Deck '+letters.join(' 和 '));button.setAttribute('aria-controls',panel.id);button.onclick=()=>show(index);
    tabs.append(button);return {panel,button};
  });
  function show(index){
    if(typeof index==='string')index=['C','D'].includes(index)?1:0;
    const changed=active!==index;active=index;
    pairs.forEach(({panel,button},i)=>{panel.hidden=i!==active;panel.inert=i!==active;button.setAttribute('aria-pressed',String(i===active));});
    container.dataset.bank=active?'CD':'AB';
    if(changed){
      if(!reduced.matches)pairs[active].panel.animate([{opacity:.8},{opacity:1}],{duration:120,easing:'ease-out'});
      window.dispatchEvent(new Event('deckbankchange'));window.dispatchEvent(new Event('resize'));
    }
  }
  show(0);
  return {show,get letters(){return active?['C','D']:['A','B'];}};
}
