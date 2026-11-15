// Adds RFC 8288 links to the previous and next page of a product list
var pageSizeLimit = 100;

var page = parseInt(context.getVariable('paging.page'), 10) || 1;
var pageSize = Math.min(
  parseInt(context.getVariable('paging.pageSize'), 10) || 20,
  pageSizeLimit
);

// The backend reports the number of matching products in "total"
var total = 0;
try {
  total = JSON.parse(context.getVariable('response.content')).total || 0;
} catch (e) {
  // A body that is not JSON gets no links
}

// Links keep the category filter of the request
var category = context.getVariable('request.queryparam.category');
var query = category ? '?category=' + encodeURIComponent(category) + '&' : '?';
var path =
  context.getVariable('proxy.basepath') +
  context.getVariable('proxy.pathsuffix');

function pageLink(number, relation) {
  return (
    '<' + path + query + 'page=' + number + '&pageSize=' + pageSize +
    '>; rel="' + relation + '"'
  );
}

var links = [];
if (page > 1) links.push(pageLink(page - 1, 'prev'));
if (page * pageSize < total) links.push(pageLink(page + 1, 'next'));
if (links.length) context.setVariable('response.header.Link', links.join(', '));
