() => {
  const rows = Array.from(document.querySelectorAll('.content_list li')).map(li => {
    const link = li.querySelector('.dd_bt a')
    const time = li.querySelector('.dd_time')?.textContent?.trim() ?? ''
    return {
      time: time.replace(/\s+/g, ' ').slice(0, 20),
      title: (link?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      url: link?.href ?? '',
    }
  }).filter(item => item.title.length >= 6 && item.url.includes('chinanews.com.cn'))
  return rows
}
