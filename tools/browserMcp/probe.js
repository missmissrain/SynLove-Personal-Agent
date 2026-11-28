() => ({
  ua: navigator.userAgent,
  hasContentList: document.querySelector('.content_list') !== null,
  listItems: document.querySelectorAll('.content_list li').length,
  liTotal: document.querySelectorAll('li').length,
  title: document.title,
  url: location.href,
})
