#!/bin/bash
set -e

git diff-files --quiet || { echo "git state not clean. please commit or stash"; exit 1; }

#get current version
currentVersion=$(git describe --tags)

#increment version
nextVersion=$(echo $currentVersion | perl -pe 's/^((\d+\.)*)(\d+)(.*)$/$1.($3+1)/e')
echo "update $currentVersion => $nextVersion"

#replace versions
sed -i -e 's/class=\"VERSION\">.*<\/span>/class=\"VERSION\">'$nextVersion'<\/span>/g' www/index.html
sed -i -e 's/class=\"VERSION\">.*<\/span>/class=\"VERSION\">'$nextVersion'<\/span>/g' landing_page/index.html

#git commit
git add www/index.html landing_page/index.html
git commit -m 'update version'
git tag $nextVersion

#deploy website
rsync -avzph landing_page/ coffee:wallet.coffee/

echo "DONE. dont forget to run git push --tags"
